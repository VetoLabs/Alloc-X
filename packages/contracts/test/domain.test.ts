import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  assertApprovalActiveAt,
  isValidXrplClassicAddress,
  parseAllocation,
  parseApproval,
  parseBeneficiary,
  parseDecisionReceipt,
  parseEvidenceManifest,
  parseLedgerTransactionResult,
  parseObligation,
  parseOrganization,
  parsePaymentIntent,
  parsePrincipal,
  parseSecurityDecision,
  validatePaymentReferenceBundle,
} from "../src/index.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function fixtures() {
  const organization = parseOrganization({
    contractVersion: "1.0",
    organizationId: "org_acme",
    displayName: "Acme Foundation",
    status: "active",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const principal = parsePrincipal({
    contractVersion: "1.0",
    principalId: "principal_alloc_agent",
    organizationId: "org_acme",
    kind: "agent",
    status: "active",
    roles: ["allocation-agent"],
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const beneficiary = parseBeneficiary({
    contractVersion: "1.0",
    beneficiaryId: "ben_vendor_7",
    organizationId: "org_acme",
    status: "approved",
    wallet: {
      network: "xrpl-classic",
      address: "rDTXLQ7ZKZVKz33zJbHjgVShjsBnqMBhmN",
      destinationTag: 11,
    },
    walletVersion: 3,
    lastWalletChangeAt: "2026-11-07T08:00:00.000Z",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const evidenceManifest = parseEvidenceManifest({
    contractVersion: "1.0",
    evidenceManifestId: "evidence_42",
    organizationId: "org_acme",
    obligationId: "obl_42",
    manifestHash: HASH_A,
    items: [
      {
        evidenceId: "evi_invoice_42",
        type: "invoice",
        contentHash: HASH_B,
        sourceSystem: "procurement",
        status: "verified",
        observedAt: "2026-11-07T08:05:00.000Z",
      },
    ],
    createdAt: "2026-11-07T08:05:00.000Z",
  });
  const obligation = parseObligation({
    contractVersion: "1.0",
    obligationId: "obl_42",
    organizationId: "org_acme",
    beneficiaryId: "ben_vendor_7",
    amount: "1250",
    asset: "XRP",
    purposeCode: "operations-supplies",
    evidenceManifestHash: HASH_A,
    dueAt: "2026-11-08T08:00:00.000Z",
    status: "open",
    createdByPrincipalId: "principal_alloc_agent",
    createdAt: "2026-11-07T08:00:00.000Z",
  });
  const allocation = parseAllocation({
    contractVersion: "1.0",
    allocationId: "alloc_operations",
    organizationId: "org_acme",
    displayName: "Operations",
    asset: "XRP",
    authorizedAmount: "2000",
    allowedPurposeCodes: ["operations-supplies"],
    activeFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-31T23:59:59.000Z",
    status: "active",
  });
  const paymentIntent = parsePaymentIntent({
    contractVersion: "1.0",
    intentId: "pi_001",
    organizationId: "org_acme",
    idempotencyKey: "org_acme/invoice-42/v1",
    sourceObligationId: "obl_42",
    allocationId: "alloc_operations",
    amount: "1250",
    asset: "XRP",
    beneficiaryId: "ben_vendor_7",
    beneficiaryWalletVersion: 3,
    purposeCode: "operations-supplies",
    evidenceManifestHash: HASH_A,
    policyVersion: "policy_2026_01",
    requestedExecutionWindow: {
      notBefore: "2026-11-07T08:30:00.000Z",
      expiresAt: "2026-11-07T09:30:00.000Z",
    },
    createdBy: {
      principalId: "principal_alloc_agent",
      actorType: "agent",
    },
  });
  return { organization, principal, beneficiary, evidenceManifest, obligation, allocation, paymentIntent };
}

test("validates checksummed XRPL classic addresses", () => {
  assert.equal(isValidXrplClassicAddress("rDTXLQ7ZKZVKz33zJbHjgVShjsBnqMBhmN"), true);
  assert.equal(isValidXrplClassicAddress("rDTXLQ7ZKZVKz33zJbHjgVShjsBnqMBhmM"), false);
  assert.equal(isValidXrplClassicAddress("rnotARealXrplAddress000000000000000"), false);
});

test("parses every core record and validates a same-organization payment reference bundle", () => {
  const bundle = fixtures();
  const validated = validatePaymentReferenceBundle(bundle);

  assert.equal(validated.organization.organizationId, "org_acme");
  assert.equal(validated.beneficiary.wallet.destinationTag, 11);
  assert.equal(Object.isFrozen(validated.evidenceManifest.items), true);
});

test("rejects unknown executable fields and malformed addresses", () => {
  assert.throws(
    () =>
      parseOrganization({
        contractVersion: "1.0",
        organizationId: "org_acme",
        displayName: "Acme",
        status: "active",
        createdAt: "2026-11-07T08:00:00.000Z",
        bypassControls: true,
      }),
    ContractValidationError,
  );

  assert.throws(
    () =>
      parseBeneficiary({
        contractVersion: "1.0",
        beneficiaryId: "ben_vendor_7",
        organizationId: "org_acme",
        status: "approved",
        wallet: { network: "xrpl-classic", address: "rDTXLQ7ZKZVKz33zJbHjgVShjsBnqMBhmM" },
        walletVersion: 1,
        lastWalletChangeAt: "2026-11-07T08:00:00.000Z",
        createdAt: "2026-11-07T08:00:00.000Z",
      }),
    ContractValidationError,
  );
});

test("rejects cross-organization references before payment security evaluation", () => {
  const bundle = fixtures();
  const foreignPrincipal = parsePrincipal({
    contractVersion: "1.0",
    principalId: "principal_alloc_agent",
    organizationId: "org_other",
    kind: "agent",
    status: "active",
    roles: ["allocation-agent"],
    createdAt: "2026-11-07T08:00:00.000Z",
  });

  assert.throws(
    () => validatePaymentReferenceBundle({ ...bundle, principal: foreignPrincipal }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.issues.includes("principal.organizationId does not match organization.organizationId"),
  );
});

test("binds approvals to a live time window and ledger results to validated identifiers", () => {
  assert.throws(
    () =>
      parseApproval({
        contractVersion: "1.0",
        approvalId: "apr_001",
        organizationId: "org_acme",
        intentId: "pi_001",
        intentDigest: HASH_A,
        principalId: "principal_cfo",
        role: "finance-approver",
        outcome: "approved",
        createdAt: "2026-11-07T09:00:00.000Z",
        expiresAt: "2026-11-07T09:00:00.000Z",
      }),
    ContractValidationError,
  );

  const validApproval = parseApproval({
    contractVersion: "1.0",
    approvalId: "apr_002",
    organizationId: "org_acme",
    intentId: "pi_001",
    intentDigest: HASH_A,
    principalId: "principal_cfo",
    role: "finance-approver",
    outcome: "approved",
    createdAt: "2026-11-07T09:00:00.000Z",
    expiresAt: "2026-11-07T10:00:00.000Z",
  });
  assert.throws(
    () => assertApprovalActiveAt(validApproval, "2026-11-07T10:00:00.000Z"),
    ContractValidationError,
  );

  assert.throws(
    () =>
      parseLedgerTransactionResult({
        contractVersion: "1.0",
        ledgerResultId: "ltr_001",
        organizationId: "org_acme",
        intentId: "pi_001",
        transactionDigest: HASH_A,
        network: "testnet",
        outcome: "validated",
        transactionHash: "not-a-ledger-hash",
        ledgerIndex: 1,
        validatedAt: "2026-11-07T09:05:00.000Z",
      }),
    ContractValidationError,
  );
});

test("requires a transaction hash on a validated decision receipt", () => {
  assert.throws(
    () =>
      parseDecisionReceipt({
        contractVersion: "1.0",
        receiptId: "receipt_001",
        organizationId: "org_acme",
        intentId: "pi_001",
        intentDigest: HASH_A,
        decisionId: "sec_001",
        policyVersion: "policy_2026_01",
        evidenceManifestHash: HASH_B,
        securityOutcome: "ALLOW",
        reasonCodes: [],
        settlement: { status: "validated" },
        receiptHash: HASH_A,
        generatedAt: "2026-11-07T09:10:00.000Z",
      }),
    ContractValidationError,
  );
});

test("validates security decisions and rejects unsupported reason codes", () => {
  const valid = parseSecurityDecision({
    contractVersion: "1.0",
    decisionId: "sec_001",
    intentId: "pi_001",
    intentDigest: HASH_A,
    outcome: "ALLOW",
    reasonCodes: [],
    requiredApprovalRoles: [],
    riskScore: 10,
    policyVersion: "policy_2026_01",
    evaluatedAt: "2026-11-07T09:00:00.000Z",
    expiresAt: "2026-11-07T09:05:00.000Z",
  });
  assert.equal(valid.outcome, "ALLOW");

  assert.throws(
    () =>
      parseSecurityDecision({
        ...valid,
        outcome: "REVIEW",
        reasonCodes: ["UNRECOGNIZED_REASON"],
      }),
    ContractValidationError,
  );
});
