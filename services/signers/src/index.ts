import { multisign, Wallet, type Transaction } from "xrpl";

import { canonicalJson, sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";
import type { PreparedXrplPayment, XrplNetwork } from "../../xrpl-adapter/src/index.ts";

export type SignerRole = "execution" | "policy" | "recovery";
export type SignerErrorCode = "INVALID_ENVELOPE" | "EXPIRED_ENVELOPE" | "UNTRUSTED_NETWORK" | "TRANSACTION_MUTATED" | "ROLE_NOT_AUTHORIZED" | "QUORUM_NOT_MET" | "INVALID_SIGNER_LIST";

export class SignerServiceError extends Error {
  readonly code: SignerErrorCode;
  constructor(code: SignerErrorCode, message: string) { super(message); this.name = "SignerServiceError"; this.code = code; }
}

/** A production adapter holds a non-exportable KMS/HSM key reference. It never returns private material. */
export interface XrplSigningKeyProvider {
  readonly keyReference: string;
  readonly classicAddress: string;
  signForMultisigning(transaction: Readonly<Record<string, unknown>>): Promise<string>;
}

export interface SignerIdentity {
  readonly signerId: string;
  readonly role: SignerRole;
  readonly keyReference: string;
  readonly classicAddress: string;
}

export interface SigningEnvelope {
  readonly contractVersion: "1.0";
  readonly organizationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly securityDecisionDigest: string;
  readonly network: XrplNetwork;
  readonly networkId: number;
  readonly transactionDigest: string;
  readonly protectedTransaction: Readonly<Record<string, unknown>>;
  readonly preparedAtLedgerIndex: number;
  readonly expiresAt: string;
  readonly envelopeDigest: string;
}

export interface SignerAuditEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly signerId: string;
  readonly role: SignerRole;
  readonly envelopeDigest: string;
  readonly transactionDigest: string;
  readonly outcome: "SIGNED" | "REFUSED";
  readonly reasonCode?: SignerErrorCode;
  readonly previousEventDigest?: string;
  readonly eventDigest: string;
}

export interface PartialMultisignature {
  readonly signerId: string;
  readonly role: SignerRole;
  readonly classicAddress: string;
  readonly envelopeDigest: string;
  readonly transactionDigest: string;
  readonly signedTransactionBlob: string;
}

export interface SignerListMember { readonly classicAddress: string; readonly weight: number; readonly role: SignerRole; }
export interface SignerListConfiguration { readonly treasuryAccount: string; readonly quorum: number; readonly members: readonly SignerListMember[]; }

/**
 * Creates the one immutable payload that may be presented to a signer. This
 * function deliberately accepts a prepared payment, rather than build inputs:
 * no signer is allowed to autofill, alter, or choose payment fields.
 */
export function createSigningEnvelope(input: {
  readonly prepared: PreparedXrplPayment;
  readonly securityDecisionDigest: string;
  readonly expiresAt: string;
}): SigningEnvelope {
  const prepared = input.prepared;
  requireDigest(prepared.intentDigest, "intentDigest"); requireDigest(input.securityDecisionDigest, "securityDecisionDigest"); requireTimestamp(input.expiresAt, "expiresAt");
  requireId(prepared.intentId, "intentId", "pi_"); requireId(prepared.organizationId, "organizationId", "org_");
  const transaction = protectedPayment(prepared.transaction, prepared.networkId);
  const transactionDigest = digestTransaction(prepared.network, prepared.networkId, transaction);
  if (!Number.isSafeInteger(prepared.preparedAtLedgerIndex) || prepared.preparedAtLedgerIndex < 1) throw new SignerServiceError("INVALID_ENVELOPE", "Prepared ledger index is invalid.");
  const base = { contractVersion: "1.0" as const, organizationId: prepared.organizationId, intentId: prepared.intentId, intentDigest: prepared.intentDigest, securityDecisionDigest: input.securityDecisionDigest, network: prepared.network, networkId: prepared.networkId, transactionDigest, protectedTransaction: transaction, preparedAtLedgerIndex: prepared.preparedAtLedgerIndex, expiresAt: input.expiresAt };
  return frozen({ ...base, envelopeDigest: sha256Digest(base as unknown as CanonicalValue) });
}

/** Validates XRPL weights before anyone can configure a settlement account. */
export function createSignerListConfiguration(input: SignerListConfiguration): SignerListConfiguration {
  requireAddress(input.treasuryAccount, "treasuryAccount");
  if (!Number.isSafeInteger(input.quorum) || input.quorum < 2) throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer quorum must require at least two independent signatures.");
  if (!Array.isArray(input.members) || input.members.length < 2 || input.members.length > 32) throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer list must contain two to 32 members.");
  const seen = new Set<string>(); let totalWeight = 0; const roles = new Set<SignerRole>();
  const members = input.members.map((member) => {
    requireAddress(member.classicAddress, "signer address");
    if (member.classicAddress === input.treasuryAccount) throw new SignerServiceError("INVALID_SIGNER_LIST", "Treasury account cannot be its own signer.");
    if (seen.has(member.classicAddress)) throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer list has a duplicate address.");
    seen.add(member.classicAddress);
    if (!Number.isSafeInteger(member.weight) || member.weight < 1 || member.weight > 65_535) throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer weight is invalid.");
    if (member.role !== "execution" && member.role !== "policy" && member.role !== "recovery") throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer role is invalid.");
    totalWeight += member.weight; roles.add(member.role); return frozen({ ...member });
  });
  if (input.quorum > totalWeight) throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer quorum cannot be met.");
  if (!roles.has("execution") || !roles.has("policy")) throw new SignerServiceError("INVALID_SIGNER_LIST", "Signer list must include execution and policy roles.");
  return frozen({ treasuryAccount: input.treasuryAccount, quorum: input.quorum, members: frozen(members) });
}

/** Builds the exact SignerListSet payload to be submitted through a separate bootstrap authority. */
export function signerListSetTransaction(configuration: SignerListConfiguration): Readonly<Record<string, unknown>> {
  const safe = createSignerListConfiguration(configuration);
  return frozen({ TransactionType: "SignerListSet", Account: safe.treasuryAccount, SignerQuorum: safe.quorum, SignerEntries: safe.members.map((member) => frozen({ SignerEntry: frozen({ Account: member.classicAddress, SignerWeight: member.weight }) })) });
}

export class IndependentSignerService {
  readonly #identity: SignerIdentity;
  readonly #keyProvider: XrplSigningKeyProvider;
  readonly #allowedNetworks: ReadonlyMap<XrplNetwork, number>;
  readonly #minimumLastLedgerOffset: number;
  readonly #maximumLastLedgerOffset: number;
  readonly #maxFeeDrops: string;
  readonly #audit: SignerAuditEvent[] = [];

  constructor(input: { readonly signerId: string; readonly role: SignerRole; readonly keyProvider: XrplSigningKeyProvider; readonly allowedNetworks: Readonly<Partial<Record<XrplNetwork, number>>>; readonly minimumLastLedgerOffset?: number; readonly maximumLastLedgerOffset?: number; readonly maxFeeDrops?: string }) {
    requireId(input.signerId, "signerId", "signer_");
    if (input.role !== "execution" && input.role !== "policy" && input.role !== "recovery") throw new TypeError("signer role is invalid.");
    requireKeyReference(input.keyProvider.keyReference); requireAddress(input.keyProvider.classicAddress, "key provider address");
    const configuredNetworks = Object.entries(input.allowedNetworks) as [XrplNetwork, number][]; const expectedNetworkIds: Readonly<Record<XrplNetwork, number>> = { mainnet: 0, testnet: 1, devnet: 2 };
    if (!configuredNetworks.length || configuredNetworks.some(([network, networkId]) => expectedNetworkIds[network] !== networkId)) throw new TypeError("allowed network id is invalid.");
    const minimumLastLedgerOffset = input.minimumLastLedgerOffset ?? 4; const maximumLastLedgerOffset = input.maximumLastLedgerOffset ?? 30; const maxFeeDrops = input.maxFeeDrops ?? "200";
    if (!Number.isSafeInteger(minimumLastLedgerOffset) || !Number.isSafeInteger(maximumLastLedgerOffset) || minimumLastLedgerOffset < 1 || maximumLastLedgerOffset < minimumLastLedgerOffset) throw new TypeError("Ledger expiry window is invalid.");
    requireDrops(maxFeeDrops, "maxFeeDrops");
    this.#identity = frozen({ signerId: input.signerId, role: input.role, keyReference: input.keyProvider.keyReference, classicAddress: input.keyProvider.classicAddress });
    this.#keyProvider = input.keyProvider; this.#allowedNetworks = new Map(configuredNetworks);
    this.#minimumLastLedgerOffset = minimumLastLedgerOffset; this.#maximumLastLedgerOffset = maximumLastLedgerOffset; this.#maxFeeDrops = maxFeeDrops;
  }

  identity(): SignerIdentity { return this.#identity; }
  auditLog(): readonly SignerAuditEvent[] { return frozen([...this.#audit]); }

  async sign(envelope: SigningEnvelope, transaction: Readonly<Record<string, unknown>>, now: string): Promise<PartialMultisignature> {
    try {
      const parsed = parseEnvelope(envelope); requireTimestamp(now, "now");
      if (Date.parse(now) >= Date.parse(parsed.expiresAt)) throw new SignerServiceError("EXPIRED_ENVELOPE", "Signing envelope has expired.");
      if (this.#allowedNetworks.get(parsed.network) !== parsed.networkId) throw new SignerServiceError("UNTRUSTED_NETWORK", "Signing envelope targets an untrusted network.");
      const candidate = protectedPayment(transaction, parsed.networkId);
      if (BigInt(candidate.Fee as string) > BigInt(this.#maxFeeDrops)) throw new SignerServiceError("TRANSACTION_MUTATED", "Transaction fee exceeds signer policy.");
      const ledgerOffset = (candidate.LastLedgerSequence as number) - parsed.preparedAtLedgerIndex;
      if (ledgerOffset < this.#minimumLastLedgerOffset || ledgerOffset > this.#maximumLastLedgerOffset) throw new SignerServiceError("TRANSACTION_MUTATED", "Transaction expiry is outside the signer safety window.");
      const candidateDigest = digestTransaction(parsed.network, parsed.networkId, candidate);
      if (candidateDigest !== parsed.transactionDigest || canonicalJson(candidate as CanonicalValue) !== canonicalJson(parsed.protectedTransaction as CanonicalValue)) throw new SignerServiceError("TRANSACTION_MUTATED", "Transaction differs from the approved signing envelope.");
      const signedTransactionBlob = await this.#keyProvider.signForMultisigning(candidate);
      if (!/^[A-F0-9]+$/.test(signedTransactionBlob)) throw new SignerServiceError("TRANSACTION_MUTATED", "Key provider returned an invalid partial signature.");
      const result = frozen({ signerId: this.#identity.signerId, role: this.#identity.role, classicAddress: this.#identity.classicAddress, envelopeDigest: parsed.envelopeDigest, transactionDigest: parsed.transactionDigest, signedTransactionBlob });
      this.#appendAudit("SIGNED", parsed, now); return result;
    } catch (error) {
      const known = error instanceof SignerServiceError ? error : new SignerServiceError("INVALID_ENVELOPE", error instanceof Error ? error.message : "Invalid signing envelope.");
      this.#appendRefusal(envelope, now, known.code); throw known;
    }
  }

  #appendAudit(outcome: "SIGNED" | "REFUSED", envelope: SigningEnvelope, occurredAt: string, reasonCode?: SignerErrorCode): void {
    const previousEventDigest = this.#audit.at(-1)?.eventDigest;
    const base = { eventId: `signer-event-${String(this.#audit.length + 1).padStart(6, "0")}`, occurredAt, signerId: this.#identity.signerId, role: this.#identity.role, envelopeDigest: envelope.envelopeDigest, transactionDigest: envelope.transactionDigest, outcome, ...(reasonCode ? { reasonCode } : {}), ...(previousEventDigest ? { previousEventDigest } : {}) };
    this.#audit.push(frozen({ ...base, eventDigest: sha256Digest(base as unknown as CanonicalValue) }));
  }
  #appendRefusal(envelope: unknown, occurredAt: string, reasonCode: SignerErrorCode): void {
    const value = envelope && typeof envelope === "object" ? envelope as Partial<SigningEnvelope> : {}; const digest = typeof value.envelopeDigest === "string" ? value.envelopeDigest : sha256Digest({ refusal: "invalid-envelope" }); const transactionDigest = typeof value.transactionDigest === "string" ? value.transactionDigest : sha256Digest({ refusal: "invalid-transaction" });
    this.#appendAudit("REFUSED", { envelopeDigest: digest, transactionDigest } as SigningEnvelope, validTimestamp(occurredAt) ? occurredAt : new Date(0).toISOString(), reasonCode);
  }
}

/** Only the coordinator may combine partial signatures; it refuses a single role or a changed envelope. */
export function assembleQuorumSignature(input: { readonly envelope: SigningEnvelope; readonly configuration: SignerListConfiguration; readonly signatures: readonly PartialMultisignature[] }): string {
  const envelope = parseEnvelope(input.envelope); const configuration = createSignerListConfiguration(input.configuration);
  const byAddress = new Map(configuration.members.map((member) => [member.classicAddress, member])); const included = new Set<string>(); const roles = new Set<SignerRole>(); let weight = 0;
  if (!Array.isArray(input.signatures) || input.signatures.length < 2) throw new SignerServiceError("QUORUM_NOT_MET", "At least two partial signatures are required.");
  for (const partial of input.signatures) {
    const member = byAddress.get(partial.classicAddress);
    if (!member || member.role !== partial.role || included.has(partial.classicAddress)) throw new SignerServiceError("QUORUM_NOT_MET", "Partial signature is not an approved independent signer.");
    if (partial.envelopeDigest !== envelope.envelopeDigest || partial.transactionDigest !== envelope.transactionDigest || !/^[A-F0-9]+$/.test(partial.signedTransactionBlob)) throw new SignerServiceError("TRANSACTION_MUTATED", "Partial signature does not bind to the signing envelope.");
    included.add(partial.classicAddress); roles.add(partial.role); weight += member.weight;
  }
  if (weight < configuration.quorum || !roles.has("execution") || !roles.has("policy")) throw new SignerServiceError("QUORUM_NOT_MET", "Execution and policy signatures must independently meet quorum.");
  return multisign(input.signatures.map((partial) => partial.signedTransactionBlob));
}

/** Test-only adapter. Production services implement XrplSigningKeyProvider with KMS/HSM-backed operations. */
export function createLocalDevelopmentKeyProvider(wallet: Wallet, keyReference: string): XrplSigningKeyProvider {
  requireKeyReference(keyReference);
  return frozen({ keyReference, classicAddress: wallet.classicAddress, signForMultisigning: async (transaction) => wallet.sign(transaction as Transaction, true).tx_blob });
}

function parseEnvelope(input: unknown): SigningEnvelope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SignerServiceError("INVALID_ENVELOPE", "Signing envelope must be an object.");
  const value = input as Record<string, unknown>; const keys = ["contractVersion", "organizationId", "intentId", "intentDigest", "securityDecisionDigest", "network", "networkId", "transactionDigest", "protectedTransaction", "preparedAtLedgerIndex", "expiresAt", "envelopeDigest"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new SignerServiceError("INVALID_ENVELOPE", "Signing envelope fields are incomplete.");
  const expectedNetworkIds: Readonly<Record<XrplNetwork, number>> = { mainnet: 0, testnet: 1, devnet: 2 };
  if (value.contractVersion !== "1.0" || (value.network !== "mainnet" && value.network !== "testnet" && value.network !== "devnet") || expectedNetworkIds[value.network] !== value.networkId) throw new SignerServiceError("INVALID_ENVELOPE", "Signing envelope metadata is invalid.");
  requireId(value.organizationId, "organizationId", "org_"); requireId(value.intentId, "intentId", "pi_"); requireDigest(value.intentDigest, "intentDigest"); requireDigest(value.securityDecisionDigest, "securityDecisionDigest"); requireDigest(value.transactionDigest, "transactionDigest"); requireDigest(value.envelopeDigest, "envelopeDigest"); requireTimestamp(value.expiresAt, "expiresAt");
  if (!Number.isSafeInteger(value.preparedAtLedgerIndex) || (value.preparedAtLedgerIndex as number) < 1) throw new SignerServiceError("INVALID_ENVELOPE", "Prepared ledger index is invalid.");
  const transaction = protectedPayment(value.protectedTransaction, value.networkId as number); const base = { contractVersion: "1.0" as const, organizationId: value.organizationId as string, intentId: value.intentId as string, intentDigest: value.intentDigest as string, securityDecisionDigest: value.securityDecisionDigest as string, network: value.network as XrplNetwork, networkId: value.networkId as number, transactionDigest: value.transactionDigest as string, protectedTransaction: transaction, preparedAtLedgerIndex: value.preparedAtLedgerIndex as number, expiresAt: value.expiresAt as string };
  if (digestTransaction(base.network, base.networkId, transaction) !== base.transactionDigest || sha256Digest(base as unknown as CanonicalValue) !== value.envelopeDigest) throw new SignerServiceError("INVALID_ENVELOPE", "Signing envelope digest does not match its contents.");
  return frozen({ ...base, envelopeDigest: value.envelopeDigest as string });
}
function protectedPayment(input: unknown, networkId: number): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SignerServiceError("INVALID_ENVELOPE", "Prepared transaction must be an object.");
  const transaction = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined)); const allowed = ["TransactionType", "Account", "Destination", "Amount", "DestinationTag", "Fee", "Sequence", "TicketSequence", "LastLedgerSequence", "NetworkID", "Flags", "Memos", "SigningPubKey"];
  for (const key of Object.keys(transaction)) if (!allowed.includes(key)) throw new SignerServiceError("TRANSACTION_MUTATED", `Unsupported XRPL transaction field ${key}.`);
  if (transaction.TransactionType !== "Payment") throw new SignerServiceError("TRANSACTION_MUTATED", "Only native payment signing is permitted.");
  requireAddress(transaction.Account, "transaction account"); requireAddress(transaction.Destination, "transaction destination"); if (transaction.Account === transaction.Destination) throw new SignerServiceError("TRANSACTION_MUTATED", "Treasury and destination cannot match.");
  requireDrops(transaction.Amount, "transaction amount"); requireDrops(transaction.Fee, "transaction fee");
  if (!Number.isSafeInteger(transaction.LastLedgerSequence) || (transaction.LastLedgerSequence as number) < 1) throw new SignerServiceError("TRANSACTION_MUTATED", "Transaction expiry is invalid.");
  if (networkId <= 1024 && transaction.NetworkID !== undefined) throw new SignerServiceError("UNTRUSTED_NETWORK", "XRPL Mainnet, Testnet, and Devnet transactions must omit NetworkID.");
  if (transaction.SigningPubKey !== undefined && transaction.SigningPubKey !== "") throw new SignerServiceError("TRANSACTION_MUTATED", "Multi-signed transaction has a non-empty SigningPubKey.");
  if (transaction.DestinationTag !== undefined && (!Number.isSafeInteger(transaction.DestinationTag) || (transaction.DestinationTag as number) < 0)) throw new SignerServiceError("TRANSACTION_MUTATED", "Destination tag is invalid.");
  if (transaction.Sequence !== undefined && (!Number.isSafeInteger(transaction.Sequence) || (transaction.Sequence as number) < 0)) throw new SignerServiceError("TRANSACTION_MUTATED", "Sequence is invalid.");
  if (transaction.TicketSequence !== undefined && (!Number.isSafeInteger(transaction.TicketSequence) || (transaction.TicketSequence as number) < 1)) throw new SignerServiceError("TRANSACTION_MUTATED", "Ticket sequence is invalid.");
  if (transaction.Sequence === 0 && transaction.TicketSequence === undefined) throw new SignerServiceError("TRANSACTION_MUTATED", "Ticket transaction is incomplete.");
  return frozen({ ...transaction, ...(transaction.NetworkID === undefined ? {} : { NetworkID: networkId }), SigningPubKey: "" });
}
function digestTransaction(network: XrplNetwork, networkId: number, transaction: Readonly<Record<string, unknown>>): string { return sha256Digest({ network, networkId, transaction } as unknown as CanonicalValue); }
function requireAddress(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) throw new SignerServiceError("INVALID_ENVELOPE", `${name} is invalid.`); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new SignerServiceError("INVALID_ENVELOPE", `${name} is invalid.`); }
function requireDigest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new SignerServiceError("INVALID_ENVELOPE", `${name} is invalid.`); }
function requireTimestamp(value: unknown, name: string): asserts value is string { if (!validTimestamp(value)) throw new SignerServiceError("INVALID_ENVELOPE", `${name} is invalid.`); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function requireDrops(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) < 1n) throw new SignerServiceError("TRANSACTION_MUTATED", `${name} is invalid.`); }
function requireKeyReference(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-z][a-z0-9:/._-]{5,200}$/.test(value)) throw new TypeError("keyReference is invalid."); }
function frozen<T>(value: T): T { return Object.freeze(value); }
