// Store only the operator's wallet preference. Never store a signing key, token, or authorization proof.
export const OPERATOR_WALLET_KEY = 'alloc-x.operator-wallet.v1';
const supported = new Set(['gemwallet', 'crossmark']);
const classicAddress = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function readOperatorWallet(storage = globalThis.localStorage) {
  try {
    const stored = JSON.parse(storage?.getItem(OPERATOR_WALLET_KEY) || 'null');
    if (!stored || stored.network !== 'testnet' || !supported.has(stored.walletId) ||
        typeof stored.address !== 'string' || !classicAddress.test(stored.address)) return null;
    return { walletId: stored.walletId, address: stored.address, network: 'testnet' };
  } catch {
    return null;
  }
}

export function rememberOperatorWallet(walletId, address, storage = globalThis.localStorage) {
  if (!supported.has(walletId) || typeof address !== 'string' || !classicAddress.test(address)) {
    throw new Error('A supported XRPL Testnet wallet with a valid public address is required.');
  }
  // Browsers may block storage: connection remains usable during this visit.
  try { storage?.setItem(OPERATOR_WALLET_KEY, JSON.stringify({ walletId, address, network: 'testnet' })); }
  catch { /* Private browsing or restricted browser storage. */ }
}

export function forgetOperatorWallet(storage = globalThis.localStorage) {
  try { storage?.removeItem(OPERATOR_WALLET_KEY); }
  catch { /* Storage may be unavailable. */ }
}
