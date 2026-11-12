import { Client, encode, validate, xrpToDrops } from "xrpl";

export type XrplNetwork = "mainnet" | "testnet" | "devnet";
export type SubmissionMode = "sequence" | "ticket";
export type XrplAdapterErrorCode = "DEPENDENCY_UNAVAILABLE" | "NETWORK_MISMATCH" | "INVALID_TRANSACTION" | "FEE_LIMIT_EXCEEDED" | "LEDGER_EXPIRY_INVALID" | "SUBMISSION_REJECTED" | "VALIDATION_FAILED";

export class XrplAdapterError extends Error {
  readonly code: XrplAdapterErrorCode;
  constructor(code: XrplAdapterErrorCode, message: string) { super(message); this.name = "XrplAdapterError"; this.code = code; }
}

export interface XrplClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request(request: Record<string, unknown>): Promise<unknown>;
  autofill(transaction: Record<string, unknown>, signersCount?: number): Promise<Record<string, unknown>>;
  submit(transaction: string, options: { readonly failHard: boolean }): Promise<unknown>;
}

export interface XrplCodec {
  xrpToDrops(value: string): string;
  isValidXRPAmount(value: string): boolean;
  validate(transaction: unknown): void;
  encode(transaction: unknown): string;
}

/** Mainnet use is dynamically controlled by the independent activation service. */
export interface MainnetAdapterGate {
  assertAdapterEnabled(input: { readonly endpoint: string; readonly networkId: number; readonly maxFeeDrops: string }): void;
}

export interface XrplAdapterOptions {
  readonly endpoint: string;
  readonly network: XrplNetwork;
  readonly expectedNetworkId: number;
  readonly maxFeeDrops: string;
  readonly minimumLastLedgerOffset: number;
  readonly maximumLastLedgerOffset: number;
  readonly targetLastLedgerOffset?: number;
  /** Number of independent multisignatures expected on submitted payments. */
  readonly signerCount?: number;
  readonly clientFactory?: (endpoint: string) => XrplClientLike;
  readonly codec?: XrplCodec;
  readonly mainnetGate?: MainnetAdapterGate;
}

export interface AccountState {
  readonly address: string;
  readonly balanceDrops: string;
  readonly sequence: number;
  readonly ownerCount: number;
  readonly validatedLedgerIndex: number;
}

export interface PaymentPreparationInput {
  readonly intentId: string;
  readonly intentDigest: string;
  readonly organizationId: string;
  readonly account: string;
  readonly destination: string;
  readonly destinationTag?: number;
  readonly amountXrp: string;
  readonly mode: SubmissionMode;
  readonly ticketSequence?: number;
}

export interface PreparedXrplPayment {
  readonly network: XrplNetwork;
  readonly networkId: number;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly organizationId: string;
  readonly transaction: Readonly<Record<string, unknown>>;
  readonly serializedTransaction: string;
  readonly preparedAtLedgerIndex: number;
}

export interface ValidatedLedgerTransaction {
  readonly transactionHash: string;
  readonly ledgerIndex: number;
  readonly validatedAt: string;
  readonly resultCode: string;
}

/**
 * Boundary around xrpl.js. It intentionally cannot sign: callers must provide
 * a separately produced signed transaction blob after independently verifying
 * the prepared transaction against the payment intent and security decision.
 */
export class XrplAdapter {
  readonly #options: Required<Pick<XrplAdapterOptions, "endpoint" | "network" | "expectedNetworkId" | "maxFeeDrops" | "minimumLastLedgerOffset" | "maximumLastLedgerOffset" | "signerCount">> & Pick<XrplAdapterOptions, "targetLastLedgerOffset">;
  readonly #clientFactory: (endpoint: string) => XrplClientLike;
  readonly #codec: XrplCodec;
  readonly #mainnetGate?: MainnetAdapterGate;

  constructor(options: XrplAdapterOptions) {
    if (!/^wss:\/\//.test(options.endpoint)) throw new TypeError("XRPL endpoint must use wss.");
    if (!Number.isSafeInteger(options.expectedNetworkId) || options.expectedNetworkId < 0) throw new TypeError("expectedNetworkId is invalid.");
    const networkIds: Readonly<Record<XrplNetwork, number>> = { mainnet: 0, testnet: 1, devnet: 2 };
    if (options.expectedNetworkId !== networkIds[options.network]) throw new TypeError("XRPL network and network ID do not match.");
    if (options.network === "mainnet" && !options.mainnetGate) throw new TypeError("XRPL Mainnet requires the independent activation gate.");
    if (!isDrops(options.maxFeeDrops)) throw new TypeError("maxFeeDrops is invalid.");
    if (!Number.isSafeInteger(options.minimumLastLedgerOffset) || !Number.isSafeInteger(options.maximumLastLedgerOffset) || options.minimumLastLedgerOffset < 1 || options.maximumLastLedgerOffset < options.minimumLastLedgerOffset) throw new TypeError("Ledger offset range is invalid.");
    if (options.targetLastLedgerOffset !== undefined && (!Number.isSafeInteger(options.targetLastLedgerOffset) || options.targetLastLedgerOffset < options.minimumLastLedgerOffset || options.targetLastLedgerOffset > options.maximumLastLedgerOffset)) throw new TypeError("targetLastLedgerOffset is invalid.");
    const signerCount = options.signerCount ?? 2; if (!Number.isSafeInteger(signerCount) || signerCount < 0 || signerCount > 32) throw new TypeError("signerCount is invalid.");
    this.#options = { endpoint: options.endpoint, network: options.network, expectedNetworkId: options.expectedNetworkId, maxFeeDrops: options.maxFeeDrops, minimumLastLedgerOffset: options.minimumLastLedgerOffset, maximumLastLedgerOffset: options.maximumLastLedgerOffset, signerCount, ...(options.targetLastLedgerOffset === undefined ? {} : { targetLastLedgerOffset: options.targetLastLedgerOffset }) };
    this.#clientFactory = options.clientFactory ?? ((endpoint) => new Client(endpoint));
    this.#codec = options.codec ?? { xrpToDrops, isValidXRPAmount: validXrpAmount, validate, encode };
    this.#mainnetGate = options.mainnetGate;
  }

  async accountState(address: string): Promise<AccountState> {
    requireAddress(address, "address");
    return this.withClient(async (client) => {
      const network = await this.assertNetwork(client);
      const response = record(await client.request({ command: "account_info", account: address, ledger_index: "validated" }), "account_info response");
      const accountData = record(response.result, "account_info result").account_data;
      const account = record(accountData, "account_data");
      const sequence = positiveInteger(account.Sequence, "account sequence"); const ownerCount = nonNegativeInteger(account.OwnerCount, "account owner count"); const balance = stringDigits(account.Balance, "account balance");
      return frozen({ address, balanceDrops: balance, sequence, ownerCount, validatedLedgerIndex: network.validatedLedgerIndex });
    });
  }

  async prepareNativePayment(input: PaymentPreparationInput): Promise<PreparedXrplPayment> {
    parsePreparation(input, this.#codec);
    return this.withClient(async (client) => {
      const network = await this.assertNetwork(client);
      const unsigned = paymentTransaction(input, this.#codec);
      let prepared: Record<string, unknown>;
      try { prepared = await client.autofill(unsigned, this.#options.signerCount); if (this.#options.targetLastLedgerOffset !== undefined) prepared = { ...prepared, LastLedgerSequence: network.validatedLedgerIndex + this.#options.targetLastLedgerOffset }; this.#codec.validate(prepared); }
      catch (error) { throw new XrplAdapterError("INVALID_TRANSACTION", `XRPL autofill rejected the payment: ${message(error)}`); }
      assertPreparedPayment(prepared, input, network.validatedLedgerIndex, this.#options);
      let serializedTransaction: string;
      try { serializedTransaction = this.#codec.encode(prepared); }
      catch (error) { throw new XrplAdapterError("INVALID_TRANSACTION", `XRPL serialization failed: ${message(error)}`); }
      if (!/^[A-F0-9]+$/.test(serializedTransaction)) throw new XrplAdapterError("INVALID_TRANSACTION", "XRPL codec returned a non-hex serialized transaction.");
      return frozen({ network: this.#options.network, networkId: network.networkId, intentId: input.intentId, intentDigest: input.intentDigest, organizationId: input.organizationId, transaction: frozen({ ...prepared }), serializedTransaction, preparedAtLedgerIndex: network.validatedLedgerIndex });
    });
  }

  async submitSignedPayment(input: { readonly prepared: PreparedXrplPayment; readonly signedTransactionBlob: string }): Promise<ValidatedLedgerTransaction> {
    if (!input.prepared || input.prepared.network !== this.#options.network || input.prepared.networkId !== this.#options.expectedNetworkId) throw new XrplAdapterError("NETWORK_MISMATCH", "Prepared payment does not target this adapter network.");
    if (typeof input.signedTransactionBlob !== "string" || !/^[A-F0-9]+$/.test(input.signedTransactionBlob)) throw new XrplAdapterError("INVALID_TRANSACTION", "Signed XRPL transaction must be uppercase hex.");
    return this.withClient(async (client) => {
      await this.assertNetwork(client);
      let submit: Record<string, unknown>;
      try { submit = record(await client.submit(input.signedTransactionBlob, { failHard: true }), "submit response"); }
      catch (error) { throw new XrplAdapterError("SUBMISSION_REJECTED", `XRPL submission failed: ${message(error)}`); }
      const result = record(submit.result, "submit result"); const preliminary = result.engine_result;
      if (typeof preliminary === "string" && preliminary !== "tesSUCCESS" && preliminary !== "terQUEUED") throw new XrplAdapterError("SUBMISSION_REJECTED", `XRPL preliminary result was ${preliminary}.`);
      const transactionJson = record(result.tx_json, "submitted transaction"); const hash = stringHash(transactionJson.hash, "transaction hash");
      return this.waitForValidation(client, hash);
    });
  }

  /** Read-only recovery lookup used before replaying a previously planned submission. */
  async lookupValidatedPayment(transactionHash: string): Promise<ValidatedLedgerTransaction | undefined> {
    if (typeof transactionHash !== "string" || !/^[A-F0-9]{64}$/.test(transactionHash)) throw new XrplAdapterError("INVALID_TRANSACTION", "Transaction hash is invalid.");
    return this.withClient(async (client) => {
      await this.assertNetwork(client);
      let response: unknown;
      try { response = await client.request({ command: "tx", transaction: transactionHash, binary: false }); }
      catch { return undefined; }
      const outer = record(response, "tx response"); const result = record(outer.result, "tx result");
      if (typeof result.error === "string" || result.validated !== true) return undefined;
      const meta = record(result.meta, "validated transaction metadata"); const resultCode = stringValue(meta.TransactionResult, "TransactionResult");
      if (resultCode !== "tesSUCCESS") return undefined;
      return frozen({ transactionHash, ledgerIndex: positiveInteger(result.ledger_index, "ledger index"), validatedAt: new Date().toISOString(), resultCode });
    });
  }

  private async assertNetwork(client: XrplClientLike): Promise<{ readonly networkId: number; readonly validatedLedgerIndex: number }> {
    if (this.#options.network === "mainnet") this.#mainnetGate!.assertAdapterEnabled({ endpoint: this.#options.endpoint, networkId: this.#options.expectedNetworkId, maxFeeDrops: this.#options.maxFeeDrops });
    let response: Record<string, unknown>;
    try { response = record(await client.request({ command: "server_info" }), "server_info response"); }
    catch (error) { throw new XrplAdapterError("DEPENDENCY_UNAVAILABLE", `XRPL server is unavailable: ${message(error)}`); }
    const info = record(record(response.result, "server_info result").info, "server_info");
    const networkId = nonNegativeInteger(info.network_id, "XRPL network_id");
    if (networkId !== this.#options.expectedNetworkId) throw new XrplAdapterError("NETWORK_MISMATCH", `XRPL network_id ${networkId} does not match configured network_id ${this.#options.expectedNetworkId}.`);
    return frozen({ networkId, validatedLedgerIndex: positiveInteger(info.validated_ledger?.seq, "validated ledger index") });
  }

  private async waitForValidation(client: XrplClientLike, hash: string): Promise<ValidatedLedgerTransaction> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const transaction = record(await client.request({ command: "tx", transaction: hash, binary: false }), "tx response"); const tx = record(transaction.result, "tx result");
        if (tx.validated !== true) { await delay(1_500); continue; }
        const meta = record(tx.meta, "validated transaction metadata"); const resultCode = stringValue(meta.TransactionResult, "TransactionResult");
        if (resultCode !== "tesSUCCESS") throw new XrplAdapterError("VALIDATION_FAILED", `XRPL validated with ${resultCode}.`);
        return frozen({ transactionHash: hash, ledgerIndex: positiveInteger(tx.ledger_index, "ledger index"), validatedAt: new Date().toISOString(), resultCode });
      } catch (error) {
        if (error instanceof XrplAdapterError && error.code === "VALIDATION_FAILED") throw error;
      }
      await delay(1_500);
    }
    throw new XrplAdapterError("VALIDATION_FAILED", "XRPL transaction did not validate before the confirmation deadline.");
  }

  private async withClient<T>(work: (client: XrplClientLike) => Promise<T>): Promise<T> {
    const client = this.#clientFactory(this.#options.endpoint);
    try { await client.connect(); return await work(client); }
    catch (error) { if (error instanceof XrplAdapterError) throw error; throw new XrplAdapterError("DEPENDENCY_UNAVAILABLE", `XRPL adapter dependency failed: ${message(error)}`); }
    finally { try { await client.disconnect(); } catch { /* connection teardown must not hide the operation result */ } }
  }
}

function paymentTransaction(input: PaymentPreparationInput, codec: XrplCodec): Record<string, unknown> {
  return { TransactionType: "Payment", Account: input.account, Destination: input.destination, Amount: codec.xrpToDrops(input.amountXrp), ...(input.destinationTag === undefined ? {} : { DestinationTag: input.destinationTag }), ...(input.mode === "ticket" ? { Sequence: 0, TicketSequence: input.ticketSequence! } : {}) };
}
function parsePreparation(input: PaymentPreparationInput, codec: XrplCodec): void {
  requireIdentifier(input.intentId, "intentId", "pi_"); requireDigest(input.intentDigest, "intentDigest"); requireIdentifier(input.organizationId, "organizationId", "org_"); requireAddress(input.account, "account"); requireAddress(input.destination, "destination");
  if (input.account === input.destination) throw new XrplAdapterError("INVALID_TRANSACTION", "Treasury and destination cannot be the same XRPL account.");
  if (!codec.isValidXRPAmount(input.amountXrp) || Number(input.amountXrp) <= 0) throw new XrplAdapterError("INVALID_TRANSACTION", "amountXrp is invalid.");
  if (input.destinationTag !== undefined && (!Number.isSafeInteger(input.destinationTag) || input.destinationTag < 0 || input.destinationTag > 4_294_967_295)) throw new XrplAdapterError("INVALID_TRANSACTION", "destinationTag is invalid.");
  if (input.mode !== "sequence" && input.mode !== "ticket") throw new XrplAdapterError("INVALID_TRANSACTION", "Submission mode is invalid.");
  if (input.mode === "ticket" && (!Number.isSafeInteger(input.ticketSequence) || input.ticketSequence! < 1)) throw new XrplAdapterError("INVALID_TRANSACTION", "ticketSequence is required for ticket submission.");
  if (input.mode === "sequence" && input.ticketSequence !== undefined) throw new XrplAdapterError("INVALID_TRANSACTION", "ticketSequence cannot accompany sequence submission.");
}
function assertPreparedPayment(transaction: Record<string, unknown>, input: PaymentPreparationInput, currentLedger: number, options: { readonly expectedNetworkId: number; readonly maxFeeDrops: string; readonly minimumLastLedgerOffset: number; readonly maximumLastLedgerOffset: number }): void {
  if (transaction.TransactionType !== "Payment" || transaction.Account !== input.account || transaction.Destination !== input.destination || transaction.Amount !== xrpDrops(input.amountXrp)) throw new XrplAdapterError("INVALID_TRANSACTION", "XRPL autofill changed a protected payment field.");
  if (input.destinationTag !== undefined && transaction.DestinationTag !== input.destinationTag) throw new XrplAdapterError("INVALID_TRANSACTION", "XRPL autofill changed destination tag.");
  if (options.expectedNetworkId <= 1024 && transaction.NetworkID !== undefined) throw new XrplAdapterError("NETWORK_MISMATCH", "XRPL Mainnet, Testnet, and Devnet transactions must omit NetworkID.");
  if (input.mode === "ticket" && (transaction.Sequence !== 0 || transaction.TicketSequence !== input.ticketSequence)) throw new XrplAdapterError("INVALID_TRANSACTION", "XRPL ticket fields are invalid.");
  if (input.mode === "sequence" && !Number.isSafeInteger(transaction.Sequence) || Number(transaction.Sequence) < 1) throw new XrplAdapterError("INVALID_TRANSACTION", "XRPL sequence is invalid.");
  const fee = stringDigits(transaction.Fee, "XRPL fee"); if (BigInt(fee) > BigInt(options.maxFeeDrops)) throw new XrplAdapterError("FEE_LIMIT_EXCEEDED", `XRPL fee ${fee} exceeds configured limit.`);
  const lastLedgerSequence = positiveInteger(transaction.LastLedgerSequence, "LastLedgerSequence"); const offset = lastLedgerSequence - currentLedger;
  if (offset < options.minimumLastLedgerOffset || offset > options.maximumLastLedgerOffset) throw new XrplAdapterError("LEDGER_EXPIRY_INVALID", "XRPL LastLedgerSequence is outside the configured safety window.");
}
function xrpDrops(amount: string): string { return xrpToDrops(amount); }
function validXrpAmount(amount: string): boolean { try { return typeof amount === "string" && /^\d+(?:\.\d{1,6})?$/.test(amount) && BigInt(xrpToDrops(amount)) > 0n; } catch { return false; } }
function record(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is malformed.`); return value as Record<string, unknown>; }
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is invalid.`); }
function requireDigest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is invalid.`); }
function requireAddress(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is invalid.`); }
function isDrops(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value); }
function stringDigits(value: unknown, name: string): string { if (!isDrops(value)) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is invalid.`); return value; }
function stringHash(value: unknown, name: string): string { if (typeof value !== "string" || !/^[A-F0-9]{64}$/.test(value)) throw new XrplAdapterError("VALIDATION_FAILED", `${name} is invalid.`); return value; }
function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new XrplAdapterError("VALIDATION_FAILED", `${name} is invalid.`); return value; }
function positiveInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is invalid.`); return value as number; }
function nonNegativeInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new XrplAdapterError("INVALID_TRANSACTION", `${name} is invalid.`); return value as number; }
function message(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function frozen<T>(value: T): T { return Object.freeze(value); }
