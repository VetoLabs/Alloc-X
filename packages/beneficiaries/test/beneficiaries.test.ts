import assert from "node:assert/strict";
import test from "node:test";

import { BeneficiaryRegistryError, InMemoryBeneficiaryRegistry } from "../src/index.ts";

const organizationId = "org_meridian";
const createdAt = "2026-11-07T10:00:00.000Z";
const evidenceHash = `sha256:${"a".repeat(64)}`;

function pendingBeneficiary(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1.0", beneficiaryId: "ben_medtech", organizationId, status: "pending", wallet: { network: "xrpl-classic", address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }, walletVersion: 1,
    lastWalletChangeAt: createdAt, createdAt, ...overrides,
  };
}

function enrollment(registry: InMemoryBeneficiaryRegistry) {
  registry.proposeEnrollment({ beneficiary: pendingBeneficiary(), verification: { verificationId: "bov_initial", method: "signed-wallet-challenge", evidenceHash, requestedAt: createdAt } });
  return registry.verifyEnrollment({ organizationId, beneficiaryId: "ben_medtech", verificationId: "bov_initial", verifiedByPrincipalId: "principal_verifier", verifiedAt: "2026-11-07T10:05:00.000Z" });
}

function changedWallet() { return { network: "xrpl-classic" as const, address: "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV" }; }

test("enrollment requires verified ownership before a beneficiary is approved", () => {
  const registry = new InMemoryBeneficiaryRegistry({ coolingPeriodHours: 24 });
  const pending = registry.proposeEnrollment({ beneficiary: pendingBeneficiary(), verification: { verificationId: "bov_initial", method: "signed-wallet-challenge", evidenceHash, requestedAt: createdAt } });
  assert.equal(pending.beneficiary.status, "pending");
  assert.equal(pending.ownership.status, "pending");
  const verified = registry.verifyEnrollment({ organizationId, beneficiaryId: "ben_medtech", verificationId: "bov_initial", verifiedByPrincipalId: "principal_verifier", verifiedAt: "2026-11-07T10:05:00.000Z" });
  assert.equal(verified.beneficiary.status, "approved");
  assert.equal(verified.ownership.status, "verified");
  assert.equal(registry.notifications(organizationId)[0]!.type, "beneficiary-enrolled");
});

test("wallet change enforces separate requester, approver, verifier, and cooling period", () => {
  const registry = new InMemoryBeneficiaryRegistry({ coolingPeriodHours: 24 });
  enrollment(registry);
  registry.proposeWalletChange({ changeId: "bwc_wallet_2", organizationId, beneficiaryId: "ben_medtech", requestedWallet: changedWallet(), requestedByPrincipalId: "principal_requester", requestedAt: "2026-11-07T11:00:00.000Z", justification: "Supplier submitted a documented treasury-wallet rotation." });
  assert.throws(() => registry.approveWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", approvedByPrincipalId: "principal_requester", approvedAt: "2026-11-07T11:05:00.000Z" }), BeneficiaryRegistryError);
  registry.approveWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", approvedByPrincipalId: "principal_approver", approvedAt: "2026-11-07T11:05:00.000Z" });
  registry.beginWalletOwnershipVerification({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", verification: { verificationId: "bov_wallet_2", method: "signed-wallet-challenge", evidenceHash, requestedAt: "2026-11-07T11:06:00.000Z" } });
  assert.throws(() => registry.verifyWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", verificationId: "bov_wallet_2", verifiedByPrincipalId: "principal_approver", verifiedAt: "2026-11-07T11:07:00.000Z" }), BeneficiaryRegistryError);
  const cooling = registry.verifyWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", verificationId: "bov_wallet_2", verifiedByPrincipalId: "principal_verifier_two", verifiedAt: "2026-11-07T11:07:00.000Z" });
  assert.equal(cooling.beneficiary.status, "pending");
  assert.equal(cooling.beneficiary.walletVersion, 2);
  assert.throws(() => registry.activateWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", activatedAt: "2026-11-08T11:06:59.999Z" }), BeneficiaryRegistryError);
  const active = registry.activateWalletChange({ organizationId, beneficiaryId: "ben_medtech", changeId: "bwc_wallet_2", activatedAt: "2026-11-08T11:07:00.000Z" });
  assert.equal(active.beneficiary.status, "approved");
  assert.equal(active.beneficiary.walletVersion, 2);
  assert.equal(active.walletHistory.length, 2);
  assert.equal(active.changes[0]!.status, "active");
});

test("freeze, disable, and tenant isolation prevent an unsafe beneficiary from appearing eligible", () => {
  const registry = new InMemoryBeneficiaryRegistry({ coolingPeriodHours: 24 });
  enrollment(registry);
  const frozen = registry.freeze({ organizationId, beneficiaryId: "ben_medtech", frozenByPrincipalId: "principal_security", frozenAt: "2026-11-07T12:00:00.000Z", reason: "Unexpected wallet-ownership signal" });
  assert.equal(frozen.lifecycle, "frozen");
  assert.equal(frozen.beneficiary.status, "disabled");
  assert.equal(registry.securityProfile(organizationId, "ben_medtech").status, "disabled");
  assert.throws(() => registry.get("org_other", "ben_medtech"), BeneficiaryRegistryError);
  const disabled = registry.disable({ organizationId, beneficiaryId: "ben_medtech", disabledByPrincipalId: "principal_security", disabledAt: "2026-11-07T12:01:00.000Z", reason: "Vendor relationship closed" });
  assert.equal(disabled.lifecycle, "disabled");
  assert.deepEqual(registry.notifications(organizationId).map((notice) => notice.type), ["beneficiary-enrolled", "beneficiary-frozen", "beneficiary-disabled"]);
});
