import assert from "node:assert/strict";
import test from "node:test";

import { addAllocation, addPayee, assignAllocationWallet, readWorkspaceRegistry, removeAllocation, removePayee, writeWorkspaceRegistry } from "../public/workspace-registry.js";

class MemoryStorage {
  #values = new Map<string, string>();
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

const healthcareWallet = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const supplierWallet = "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV";

test("workspace registry supports unlimited named allocations with independent wallets", () => {
  let registry = readWorkspaceRegistry(new MemoryStorage());
  for (let index = 1; index <= 12; index += 1) {
    registry = addAllocation(registry, { name: `Program ${index}`, category: "Restricted grant", purpose: `Purpose ${index}` }).registry;
  }
  assert.equal(registry.allocations.length, 12);
  const first = registry.allocations[0]!;
  registry = assignAllocationWallet(registry, first.allocationId, healthcareWallet);
  assert.equal(registry.allocations[0]!.walletAddress, healthcareWallet);
  assert.equal(registry.allocations[1]!.walletAddress, "");
});

test("workspace registry persists allocations and typed payees and removes only the selected record", () => {
  const storage = new MemoryStorage();
  let registry = readWorkspaceRegistry(storage);
  const allocationResult = addAllocation(registry, { name: "Healthcare Grant", category: "Restricted grant", walletAddress: healthcareWallet });
  const allocation = allocationResult.allocation;
  registry = allocationResult.registry;
  const payeeResult = addPayee(registry, { name: "MedTech Supplies", type: "SUPPLIER", role: "Medical equipment", walletAddress: supplierWallet });
  registry = payeeResult.registry;
  writeWorkspaceRegistry(registry, storage);

  const restored = readWorkspaceRegistry(storage);
  assert.equal(restored.allocations[0]!.name, "Healthcare Grant");
  assert.equal(restored.payees[0]!.type, "SUPPLIER");
  assert.equal(restored.payees[0]!.status, "PENDING_VERIFICATION");
  assert.equal(removeAllocation(restored, allocation.allocationId).allocations.length, 0);
  assert.equal(removePayee(restored, payeeResult.payee.payeeId).payees.length, 0);
});

test("workspace registry rejects duplicate names, duplicate payee wallets, and invalid addresses", () => {
  let registry = addAllocation(readWorkspaceRegistry(new MemoryStorage()), { name: "Education", category: "Program allocation" }).registry;
  assert.throws(() => addAllocation(registry, { name: "education", category: "Department budget" }), /already exists/i);
  assert.throws(() => addAllocation(registry, { name: "Sport", walletAddress: "not-an-address" }), /valid XRPL/i);
  registry = addPayee(registry, { name: "Ada", type: "EMPLOYEE", walletAddress: supplierWallet }).registry;
  assert.throws(() => addPayee(registry, { name: "Another person", type: "EMPLOYEE", walletAddress: supplierWallet }), /already registered/i);
});
