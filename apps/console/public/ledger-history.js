// Read-only XRPL Testnet transaction normalization. Ledger records are not
// treated as signed Alloc-X approvals unless the application has a matching receipt.
export function outgoingNativePayments(transactions, account) {
  if (!Array.isArray(transactions) || typeof account !== 'string') return [];
  return transactions.flatMap((entry) => {
    if (!entry || entry.validated !== true) return [];
    const tx = entry.tx_json || entry.tx || entry.transaction;
    const meta = entry.meta || entry.metaData;
    if (!tx || !meta || tx.TransactionType !== 'Payment' || tx.Account !== account || meta.TransactionResult !== 'tesSUCCESS') return [];
    if (typeof tx.Amount !== 'string' || !/^[0-9]+$/.test(tx.Amount)) return []; // Ignore issued currencies.
    if (typeof tx.Destination !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(tx.Destination)) return [];
    const hash = String(entry.hash || tx.hash || '').toUpperCase();
    if (!/^[A-F0-9]{64}$/.test(hash)) return [];
    const drops = Number(tx.Amount);
    if (!Number.isSafeInteger(drops) || drops <= 0) return [];
    const time = entry.close_time_iso || tx.close_time_iso || (Number.isFinite(tx.date) ? new Date((tx.date + 946684800) * 1000).toISOString() : null);
    const timestamp = time && Number.isFinite(Date.parse(time)) ? time : null;
    return [{ hash, sourceAccount: account, destination: tx.Destination, amountXrp: drops / 1_000_000,
      timestamp, ledgerIndex: Number(entry.ledger_index || tx.ledger_index || 0) || null }];
  });
}
