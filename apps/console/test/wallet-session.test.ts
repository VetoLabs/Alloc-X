import assert from "node:assert/strict";
import test from "node:test";
import { forgetOperatorWallet, OPERATOR_WALLET_KEY, readOperatorWallet, rememberOperatorWallet } from "../public/wallet-session.js";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
  removeItem(key: string): void { this.#items.delete(key); }
}
const xrplAddress = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

test("GemWallet public operator preference persists across reloads with no credentials", () => {
  const browserStorage = new MemoryStorage();
  rememberOperatorWallet("gemwallet", xrplAddress, browserStorage);
  assert.deepEqual(readOperatorWallet(browserStorage), { walletId: "gemwallet", address: xrplAddress, network: "testnet" });
  const raw = browserStorage.getItem(OPERATOR_WALLET_KEY) ?? "";
  assert.doesNotMatch(raw, /secret|private|seed|token|password/i);
  forgetOperatorWallet(browserStorage);
  assert.equal(readOperatorWallet(browserStorage), null);
});

test("Crossmark is also remembered; unsupported, mainnet, and invalid records fail closed", () => {
  const storage = new MemoryStorage();
  rememberOperatorWallet("crossmark", xrplAddress, storage);
  assert.equal(readOperatorWallet(storage)?.walletId, "crossmark");
  assert.throws(() => rememberOperatorWallet("metamask", xrplAddress, storage), /supported XRPL Testnet/);
  assert.throws(() => rememberOperatorWallet("gemwallet", "not-an-xrpl-address", storage), /supported XRPL Testnet/);
  storage.setItem(OPERATOR_WALLET_KEY, JSON.stringify({ walletId: "gemwallet", address: xrplAddress, network: "mainnet" }));
  assert.equal(readOperatorWallet(storage), null);
  storage.setItem(OPERATOR_WALLET_KEY, "{not-json");
  assert.equal(readOperatorWallet(storage), null);
});
