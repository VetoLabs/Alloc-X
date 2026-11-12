import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePaymentIntentWithTrace } from "../../policy-engine/src/index.ts";
import { InMemoryBeneficiaryRegistry } from "../src/index.ts";

const organizationId = "org_meridian";
const now = "2026-11-07T12:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

function registry() {
  const value = new InMemoryBeneficiaryRegistry({ coolingPeriodHours: 24 });
  value.proposeEnrollment({ beneficiary: { contractVersion: "1.0", beneficiaryId: "ben_medtech", organizationId, status: "pending", wallet: { network: "xrpl-classic", address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }, walletVersion: 1, lastWalletChangeAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }, verification: { verificationId: "bov_initial", method: "signed-wallet-challenge", evidenceHash: hash, requestedAt: "2026-01-01T00:00:00.000Z" } });
  value.verifyEnrollment({ organizationId, beneficiaryId: "ben_medtech", verificationId: "bov_initial", verifiedByPrincipalId: "principal_enrollment_verifier", verifiedAt: "2026-01-01T00:01:00.000Z" });
  return value;
}

const intent = {
  contractVersion: "1.0", intentId: "pi_existing_payment", organizationId, idempotencyKey: "meridian/invoice-7/v1", sourceObligationId: "obl_existing", allocationId: "alloc_clinic", amount: "1350", asset: "XRP", beneficiaryId: "ben_medtech", beneficiaryWalletVersion: 1, purposeCode: "operations-supplies", evidenceManifestHash: hash, policyVersion: "policy_meridian_2026", requestedExecutionWindow: { notBefore: now, expiresAt: "2026-11-07T12:30:00.000Z" }, createdBy: { principalId: "principal_allocation_agent", actorType: "agent" },
};
const policy = { policyVersion: "policy_meridian_2026", organizationId, status: "published", effectiveFrom: "2026-01-01T00:00:00.000Z", allowedPurposeCodes: ["operations-supplies"], allowedAssets: ["XRP"], maxPaymentAmount: "5000", reserveFloor: "1000", requiredEvidenceByPurpose: { "operations-supplies": ["invoice"] }, approvalRules: [], beneficiaryChangeCoolingPeriodHours: 24, velocity: { maxPaymentCount24Hours: 10, maxPaymentAmount24Hours: "10000" }, risk: { reviewAtScore: 60, denyAtScore: 85 }, decisionTtlSeconds: 300 };

test("a wallet change makes an existing intent ineligible before any signer can use its original destination", () => {
  const value = registry();
  value.proposeWalletChange({ changeId: "bwc_existing_wallet", organizationId, beneficiaryId: "ben_medtech", requestedWallet: { network: "xrpl-classic", address: "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV" }, requestedByPrincipalId: "principal_requester", requestedAt: "2026-11-07T11:00:00.000Z", justification: "Vendor wallet rotation evidence received." });
  value.approveWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_existing_wallet", approvedByPrincipalId: "principal_approver", approvedAt: "2026-11-07T11:01:00.000Z" });
  value.beginWalletOwnershipVerification({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_existing_wallet", verification: { verificationId: "bov_existing_wallet", method: "signed-wallet-challenge", evidenceHash: hash, requestedAt: "2026-11-07T11:02:00.000Z" } });
  value.verifyWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_existing_wallet", verificationId: "bov_existing_wallet", verifiedByPrincipalId: "principal_wallet_verifier", verifiedAt: "2026-11-07T11:03:00.000Z" });
  const profile = value.securityProfile(organizationId, "ben_medtech");
  const evaluated = evaluatePaymentIntentWithTrace(intent, policy, { now, availableTreasuryBalance: "10000", availableAllocationBalance: "3000", beneficiary: { beneficiaryId: profile.beneficiaryId, walletVersion: profile.walletVersion, status: profile.status, lastWalletChangeAt: profile.lastWalletChangeAt }, evidence: { manifestHash: hash, evidenceTypes: ["invoice"], duplicateStatus: "clear", procurementStatus: "verified", integrityStatus: "verified" }, approvals: [], recentPayments: [], seenIntentDigests: [], riskScore: 10, securityDependencies: { policyStore: "available", beneficiaryRegistry: "available", evidenceStore: "available", riskEngine: "available" } });
  assert.equal(evaluated.decision.outcome, "DENY");
  assert.ok(evaluated.decision.reasonCodes.includes("BENEFICIARY_NOT_APPROVED"));
  assert.ok(evaluated.decision.reasonCodes.includes("BENEFICIARY_VERSION_MISMATCH"));
});
