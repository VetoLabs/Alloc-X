import assert from "node:assert/strict";
import test from "node:test";

import { decode, Wallet } from "xrpl";

import {
  assembleQuorumSignature,
  createLocalDevelopmentKeyProvider,
  createSignerListConfiguration,
  createSigningEnvelope,
  IndependentSignerService,
  signerListSetTransaction,
  SignerServiceError,
} from "../src/index.ts";

const treasury = Wallet.generate();
const executionWallet = Wallet.generate();
const policyWallet = Wallet.generate();
const recoveryWallet = Wallet.generate();

function prepared() {
  return {
    network: "testnet" as const, networkId: 1, intentId: "pi_signing_001", intentDigest: `sha256:${"a".repeat(64)}`, organizationId: "org_meridian",
    transaction: { TransactionType: "Payment", Account: treasury.classicAddress, Destination: Wallet.generate().classicAddress, Amount: "1000000", Fee: "36", Sequence: 7, LastLedgerSequence: 999_999 },
    serializedTransaction: "DEADBEEF", preparedAtLedgerIndex: 999_980,
  };
}
function envelope() { return createSigningEnvelope({ prepared: prepared(), securityDecisionDigest: `sha256:${"b".repeat(64)}`, expiresAt: "2030-01-01T00:00:00.000Z" }); }
function signer(role: "execution" | "policy", wallet: Wallet) {
  return new IndependentSignerService({ signerId: `signer_${role}_001`, role, keyProvider: createLocalDevelopmentKeyProvider(wallet, `local:${role}:key-001`), allowedNetworks: { testnet: 1, devnet: 2 } });
}
function configuration() { return createSignerListConfiguration({ treasuryAccount: treasury.classicAddress, quorum: 2, members: [{ classicAddress: executionWallet.classicAddress, weight: 1, role: "execution" }, { classicAddress: policyWallet.classicAddress, weight: 1, role: "policy" }, { classicAddress: recoveryWallet.classicAddress, weight: 2, role: "recovery" }] }); }

test("independent execution and policy signers only sign the immutable exact transaction", async () => {
  const signedEnvelope = envelope(); const execution = signer("execution", executionWallet); const policy = signer("policy", policyWallet);
  const executionPartial = await execution.sign(signedEnvelope, signedEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z");
  const policyPartial = await policy.sign(signedEnvelope, signedEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z");
  const blob = assembleQuorumSignature({ envelope: signedEnvelope, configuration: configuration(), signatures: [executionPartial, policyPartial] });
  const transaction = decode(blob) as Record<string, unknown>;
  assert.equal(transaction.SigningPubKey, ""); assert.equal((transaction.Signers as unknown[]).length, 2);
  assert.equal(execution.auditLog()[0].outcome, "SIGNED"); assert.equal(policy.auditLog()[0].transactionDigest, signedEnvelope.transactionDigest);
});

test("refuses altered amount, destination, fee, expiry, or network before a key provider is called", async () => {
  const signedEnvelope = envelope(); const execution = signer("execution", executionWallet); const changes = [
    { Amount: "1000001" }, { Destination: Wallet.generate().classicAddress }, { Fee: "37" }, { LastLedgerSequence: 1_000_000 }, { NetworkID: 0 },
  ];
  for (const change of changes) await assert.rejects(() => execution.sign(signedEnvelope, { ...signedEnvelope.protectedTransaction, ...change }, "2029-12-31T23:00:00.000Z"), (error: unknown) => error instanceof SignerServiceError && (error.code === "TRANSACTION_MUTATED" || error.code === "UNTRUSTED_NETWORK"));
  assert.equal(execution.auditLog().every((event) => event.outcome === "REFUSED"), true);
});

test("enforces an independent configurable fee ceiling", async () => {
  const highFeePrepared = { ...prepared(), transaction: { ...prepared().transaction, Fee: "201" } };
  const signedEnvelope = createSigningEnvelope({ prepared: highFeePrepared, securityDecisionDigest: `sha256:${"b".repeat(64)}`, expiresAt: "2030-01-01T00:00:00.000Z" });
  const defaultCeiling = signer("execution", executionWallet);
  await assert.rejects(() => defaultCeiling.sign(signedEnvelope, signedEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z"), (error: unknown) => error instanceof SignerServiceError && error.code === "TRANSACTION_MUTATED");
  const configuredCeiling = new IndependentSignerService({ signerId: "signer_execution_002", role: "execution", keyProvider: createLocalDevelopmentKeyProvider(executionWallet, "local:execution:key-002"), allowedNetworks: { testnet: 1, devnet: 2 }, maxFeeDrops: "300" });
  await assert.doesNotReject(() => configuredCeiling.sign(signedEnvelope, signedEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z"));
});

test("a single signer cannot assemble settlement and the signer-list requires independent roles", async () => {
  const signedEnvelope = envelope(); const execution = signer("execution", executionWallet); const policy = signer("policy", policyWallet);
  const execPartial = await execution.sign(signedEnvelope, signedEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z");
  assert.throws(() => assembleQuorumSignature({ envelope: signedEnvelope, configuration: configuration(), signatures: [execPartial] }), (error: unknown) => error instanceof SignerServiceError && error.code === "QUORUM_NOT_MET");
  const policyPartial = await policy.sign(signedEnvelope, signedEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z");
  assert.match(assembleQuorumSignature({ envelope: signedEnvelope, configuration: configuration(), signatures: [execPartial, policyPartial] }), /^[A-F0-9]+$/);
});

test("signer-list configuration prevents a single-role quorum and encodes an XRPL SignerListSet payload", () => {
  const config = configuration(); const transaction = signerListSetTransaction(config);
  assert.deepEqual(transaction, { TransactionType: "SignerListSet", Account: treasury.classicAddress, SignerQuorum: 2, SignerEntries: [{ SignerEntry: { Account: executionWallet.classicAddress, SignerWeight: 1 } }, { SignerEntry: { Account: policyWallet.classicAddress, SignerWeight: 1 } }, { SignerEntry: { Account: recoveryWallet.classicAddress, SignerWeight: 2 } }] });
  assert.throws(() => createSignerListConfiguration({ treasuryAccount: treasury.classicAddress, quorum: 1, members: [{ classicAddress: executionWallet.classicAddress, weight: 1, role: "execution" }, { classicAddress: policyWallet.classicAddress, weight: 1, role: "policy" }] }), (error: unknown) => error instanceof SignerServiceError && error.code === "INVALID_SIGNER_LIST");
});

test("permits explicitly allowlisted Mainnet signing while requiring NetworkID to be omitted", async () => {
  const mainnetPrepared = { ...prepared(), network: "mainnet" as const, networkId: 0 };
  const mainnetEnvelope = createSigningEnvelope({ prepared: mainnetPrepared, securityDecisionDigest: `sha256:${"b".repeat(64)}`, expiresAt: "2030-01-01T00:00:00.000Z" });
  const mainnetSigner = new IndependentSignerService({ signerId: "signer_execution_mainnet", role: "execution", keyProvider: createLocalDevelopmentKeyProvider(executionWallet, "local:execution:mainnet"), allowedNetworks: { mainnet: 0 } });
  await assert.doesNotReject(() => mainnetSigner.sign(mainnetEnvelope, mainnetEnvelope.protectedTransaction, "2029-12-31T23:00:00.000Z"));
  await assert.rejects(() => mainnetSigner.sign(mainnetEnvelope, { ...mainnetEnvelope.protectedTransaction, NetworkID: 0 }, "2029-12-31T23:00:00.000Z"), (error: unknown) => error instanceof SignerServiceError && error.code === "UNTRUSTED_NETWORK");
});
