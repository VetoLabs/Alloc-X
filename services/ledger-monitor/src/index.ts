import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "xrpl";
import { canonicalJson, sha256Digest, type CanonicalValue } from "../../../packages/contracts/src/index.ts";

export interface ValidatedTreasuryTransaction {
  readonly transactionHash: string;
  readonly ledgerIndex: number;
  readonly account: string;
  readonly destination: string;
  readonly amountDrops: string;
  readonly resultCode: "tesSUCCESS";
  readonly validatedAt: string;
}

export interface ExpectedSettlement {
  readonly jobId: string;
  readonly organizationId: string;
  readonly reservationId: string;
  readonly transactionHash: string;
  readonly account: string;
  readonly destination: string;
  readonly amountDrops: string;
}

export interface LedgerPage { readonly transactions: readonly ValidatedTreasuryTransaction[]; readonly cursor?: string; }
/** A read-only boundary. Implementations must not hold a signing secret. */
export interface ReadOnlyLedgerSource { readValidatedPayments(input: { readonly account: string; readonly cursor?: string }): Promise<LedgerPage>; }
/** Implemented by accounting; settle must be idempotent for the same hash. */
export interface AccountingFinalizer { settle(input: { readonly reservationId: string; readonly settledAt: string; readonly transactionHash: string }): Promise<unknown> | unknown; }

export interface Reconciliation {
  readonly reconciliationId: string;
  readonly jobId: string;
  readonly organizationId: string;
  readonly reservationId: string;
  readonly transactionHash: string;
  readonly ledgerIndex: number;
  readonly reconciledAt: string;
  readonly digest: string;
}

export interface TreasuryAlert {
  readonly alertId: string;
  readonly organizationId: string;
  readonly transactionHash: string;
  readonly account: string;
  readonly destination: string;
  readonly amountDrops: string;
  readonly ledgerIndex: number;
  readonly code: "UNKNOWN_TREASURY_OUTFLOW" | "EXPECTED_TRANSACTION_MISMATCH";
  readonly raisedAt: string;
  readonly digest: string;
}

export interface LedgerMonitorIntegrity { readonly valid: boolean; readonly checkedRecords: number; readonly failures: readonly ("MALFORMED_RECORD" | "PREVIOUS_HASH_MISMATCH" | "RECORD_HASH_MISMATCH")[]; }
export interface LedgerMonitorStore {
  registerExpected(input: ExpectedSettlement): Promise<ExpectedSettlement> | ExpectedSettlement;
  expected(transactionHash: string): Promise<ExpectedSettlement | undefined> | ExpectedSettlement | undefined;
  seen(transactionHash: string): Promise<boolean> | boolean;
  markSeen(transactionHash: string): Promise<void> | void;
  cursor(account: string): Promise<string | undefined> | string | undefined;
  setCursor(account: string, cursor: string | undefined): Promise<void> | void;
  reconcile(value: Reconciliation): Promise<Reconciliation> | Reconciliation;
  alert(value: TreasuryAlert): Promise<TreasuryAlert> | TreasuryAlert;
  reconciliations(): Promise<readonly Reconciliation[]> | readonly Reconciliation[];
  alerts(): Promise<readonly TreasuryAlert[]> | readonly TreasuryAlert[];
}

export class LedgerMonitorError extends Error { constructor(message: string) { super(message); this.name = "LedgerMonitorError"; } }

export interface XrplReadClient { connect(): Promise<void>; disconnect(): Promise<void>; request(request: Record<string, unknown>): Promise<unknown>; }
export interface XrplReadOnlyLedgerSourceOptions { readonly endpoint: string; readonly expectedNetworkId: number; readonly clientFactory?: (endpoint: string) => XrplReadClient; }

/** XRPL account_tx adapter. It only uses server_info and account_tx read requests. */
export class XrplReadOnlyLedgerSource implements ReadOnlyLedgerSource {
  readonly #endpoint: string;
  readonly #expectedNetworkId: number;
  readonly #clientFactory: (endpoint: string) => XrplReadClient;
  constructor(options: XrplReadOnlyLedgerSourceOptions) {
    if (!/^wss:\/\//.test(options.endpoint)) throw new LedgerMonitorError("XRPL endpoint must use wss.");
    if (!Number.isSafeInteger(options.expectedNetworkId) || options.expectedNetworkId < 0) throw new LedgerMonitorError("Expected XRPL network id is invalid.");
    this.#endpoint = options.endpoint; this.#expectedNetworkId = options.expectedNetworkId; this.#clientFactory = options.clientFactory ?? ((endpoint) => new Client(endpoint));
  }
  async readValidatedPayments(input: { readonly account: string; readonly cursor?: string }): Promise<LedgerPage> {
    requireAddress(input.account, "account");
    const marker = input.cursor === undefined ? undefined : parseCursor(input.cursor);
    const client = this.#clientFactory(this.#endpoint);
    try {
      await client.connect();
      const server = readRecord(await client.request({ command: "server_info" }), "server_info response");
      const info = readRecord(readRecord(server.result, "server_info result").info, "server_info");
      if (info.network_id !== this.#expectedNetworkId) throw new LedgerMonitorError("XRPL network id does not match the monitor configuration.");
      const response = readRecord(await client.request({ command: "account_tx", account: input.account, ledger_index_min: -1, ledger_index_max: -1, binary: false, forward: true, limit: 200, ...(marker === undefined ? {} : { marker }) }), "account_tx response");
      const result = readRecord(response.result, "account_tx result");
      if (result.validated !== true) throw new LedgerMonitorError("XRPL account history was not confirmed against a validated ledger.");
      const entries = Array.isArray(result.transactions) ? result.transactions : [];
      const transactions = entries.map((entry) => parseAccountTransaction(entry, input.account)).filter((entry): entry is ValidatedTreasuryTransaction => entry !== undefined);
      const cursor = result.marker === undefined ? undefined : JSON.stringify(result.marker);
      return frozen({ transactions: frozen(transactions), ...(cursor === undefined ? {} : { cursor }) });
    } catch (error) { if (error instanceof LedgerMonitorError) throw error; throw new LedgerMonitorError(`XRPL read dependency failed: ${message(error)}`); }
    finally { try { await client.disconnect(); } catch { /* teardown must not hide monitoring result */ } }
  }
}

/** Useful for tests and local development only; deployed state uses FileLedgerMonitorStore or a database adapter. */
export class InMemoryLedgerMonitorStore implements LedgerMonitorStore {
  readonly #expected = new Map<string, ExpectedSettlement>();
  readonly #seen = new Set<string>();
  readonly #reconciliations = new Map<string, Reconciliation>();
  readonly #alerts = new Map<string, TreasuryAlert>();
  readonly #cursors = new Map<string, string>();
  registerExpected(input: ExpectedSettlement): ExpectedSettlement { validateExpected(input); const prior = this.#expected.get(input.transactionHash); if (prior && canonicalJson(prior as unknown as CanonicalValue) !== canonicalJson(input as unknown as CanonicalValue)) throw new LedgerMonitorError("Transaction hash cannot be rebound."); const value = frozen({ ...input }); this.#expected.set(input.transactionHash, value); return value; }
  expected(hash: string): ExpectedSettlement | undefined { return this.#expected.get(hash); }
  seen(hash: string): boolean { return this.#seen.has(hash); }
  markSeen(hash: string): void { this.#seen.add(hash); }
  cursor(account: string): string | undefined { return this.#cursors.get(account); }
  setCursor(account: string, cursor: string | undefined): void { if (cursor) this.#cursors.set(account, cursor); else this.#cursors.delete(account); }
  reconcile(value: Reconciliation): Reconciliation { const prior = this.#reconciliations.get(value.transactionHash); if (prior) return prior; this.#reconciliations.set(value.transactionHash, frozen(value)); return value; }
  alert(value: TreasuryAlert): TreasuryAlert { const prior = this.#alerts.get(value.transactionHash); if (prior) return prior; this.#alerts.set(value.transactionHash, frozen(value)); return value; }
  reconciliations(): readonly Reconciliation[] { return frozen([...this.#reconciliations.values()]); }
  alerts(): readonly TreasuryAlert[] { return frozen([...this.#alerts.values()]); }
}

type MonitorEventType = "EXPECTED_REGISTERED" | "TRANSACTION_OBSERVED" | "CURSOR_SET" | "RECONCILED" | "ALERT_RAISED";
interface MonitorEvent { readonly contractVersion: "1.0"; readonly eventType: MonitorEventType; readonly occurredAt: string; readonly value: CanonicalValue; readonly previousRecordHash: string; readonly recordHash: string; }
interface MonitorState { readonly expected: Map<string, ExpectedSettlement>; readonly seen: Set<string>; readonly cursors: Map<string, string>; readonly reconciliations: Map<string, Reconciliation>; readonly alerts: Map<string, TreasuryAlert>; }

/** Append-only, fsynced monitor state. An integrity failure prevents cursor advancement. */
export class FileLedgerMonitorStore implements LedgerMonitorStore {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string) { if (typeof path !== "string" || path.length === 0) throw new TypeError("Ledger monitor journal path is required."); this.#path = path; }
  async registerExpected(input: ExpectedSettlement): Promise<ExpectedSettlement> { validateExpected(input); return this.serial(async () => { const state = await this.state(); const prior = state.expected.get(input.transactionHash); if (prior) { if (canonicalJson(prior as unknown as CanonicalValue) !== canonicalJson(input as unknown as CanonicalValue)) throw new LedgerMonitorError("Transaction hash cannot be rebound."); return prior; } const value = frozen({ ...input }); await this.append("EXPECTED_REGISTERED", value as unknown as CanonicalValue); return value; }); }
  async expected(hash: string): Promise<ExpectedSettlement | undefined> { return (await this.state()).expected.get(hash); }
  async seen(hash: string): Promise<boolean> { return (await this.state()).seen.has(hash); }
  async cursor(account: string): Promise<string | undefined> { return (await this.state()).cursors.get(account); }
  async reconciliations(): Promise<readonly Reconciliation[]> { return frozen([...((await this.state()).reconciliations.values())]); }
  async alerts(): Promise<readonly TreasuryAlert[]> { return frozen([...((await this.state()).alerts.values())]); }
  async markSeen(transactionHash: string): Promise<void> { requireHash(transactionHash); await this.serial(async () => { if (!(await this.state()).seen.has(transactionHash)) await this.append("TRANSACTION_OBSERVED", { transactionHash }); }); }
  async setCursor(account: string, cursor: string | undefined): Promise<void> { requireAddress(account, "account"); if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 10_000)) throw new LedgerMonitorError("Cursor is invalid."); await this.serial(async () => { await this.append("CURSOR_SET", cursor === undefined ? { account } : { account, cursor }); }); }
  async reconcile(value: Reconciliation): Promise<Reconciliation> { validateReconciliation(value); return this.serial(async () => { const prior = (await this.state()).reconciliations.get(value.transactionHash); if (prior) return prior; await this.append("RECONCILED", value as unknown as CanonicalValue); return frozen(value); }); }
  async alert(value: TreasuryAlert): Promise<TreasuryAlert> { validateAlert(value); return this.serial(async () => { const prior = (await this.state()).alerts.get(value.transactionHash); if (prior) return prior; await this.append("ALERT_RAISED", value as unknown as CanonicalValue); return frozen(value); }); }
  async verifyIntegrity(): Promise<LedgerMonitorIntegrity> { const lines = await this.lines(); const failures = new Set<LedgerMonitorIntegrity["failures"][number]>(); let prior = genesisHash(); for (const line of lines) { try { const event = JSON.parse(line) as MonitorEvent; if (!isMonitorEvent(event)) { failures.add("MALFORMED_RECORD"); continue; } if (event.previousRecordHash !== prior) failures.add("PREVIOUS_HASH_MISMATCH"); const { recordHash: ignored, ...base } = event; if (sha256Digest(base as unknown as CanonicalValue) !== event.recordHash) failures.add("RECORD_HASH_MISMATCH"); prior = event.recordHash; } catch { failures.add("MALFORMED_RECORD"); } } return frozen({ valid: failures.size === 0, checkedRecords: lines.length, failures: frozen([...failures].sort()) }); }
  private async state(): Promise<MonitorState> { const integrity = await this.verifyIntegrity(); if (!integrity.valid) throw new LedgerMonitorError("Ledger monitor journal integrity verification failed."); const state: MonitorState = { expected: new Map(), seen: new Set(), cursors: new Map(), reconciliations: new Map(), alerts: new Map() }; for (const line of await this.lines()) { const event = JSON.parse(line) as MonitorEvent; if (event.eventType === "EXPECTED_REGISTERED") { const value = event.value as unknown as ExpectedSettlement; validateExpected(value); state.expected.set(value.transactionHash, frozen(value)); } if (event.eventType === "TRANSACTION_OBSERVED") { const value = event.value as { transactionHash: string }; requireHash(value.transactionHash); state.seen.add(value.transactionHash); } if (event.eventType === "CURSOR_SET") { const value = event.value as { account: string; cursor?: string }; requireAddress(value.account, "account"); if (value.cursor === undefined) state.cursors.delete(value.account); else state.cursors.set(value.account, value.cursor); } if (event.eventType === "RECONCILED") { const value = event.value as unknown as Reconciliation; validateReconciliation(value); state.reconciliations.set(value.transactionHash, frozen(value)); } if (event.eventType === "ALERT_RAISED") { const value = event.value as unknown as TreasuryAlert; validateAlert(value); state.alerts.set(value.transactionHash, frozen(value)); } } return state; }
  private async append(eventType: MonitorEventType, value: CanonicalValue): Promise<void> { const lines = await this.lines(); const previousRecordHash = lines.length === 0 ? genesisHash() : (JSON.parse(lines.at(-1)!) as MonitorEvent).recordHash; const base = { contractVersion: "1.0" as const, eventType, occurredAt: new Date().toISOString(), value, previousRecordHash }; const event = frozen({ ...base, recordHash: sha256Digest(base as unknown as CanonicalValue) }); await mkdir(dirname(this.#path), { recursive: true }); const file = await open(this.#path, "a"); try { await file.writeFile(`${canonicalJson(event as unknown as CanonicalValue)}\n`); await file.sync(); } finally { await file.close(); } }
  private async lines(): Promise<readonly string[]> { try { return (await readFile(this.#path, "utf8")).split("\n").filter(Boolean); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async serial<T>(work: () => Promise<T>): Promise<T> { const prior = this.#tail; let release: () => void = () => undefined; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior; try { return await work(); } finally { release(); } }
}

/** Read-only poller. It cannot construct, sign, submit, or alter an XRPL transaction. */
export class LedgerMonitor {
  readonly #source: ReadOnlyLedgerSource;
  readonly #store: LedgerMonitorStore;
  readonly #accounting?: AccountingFinalizer;
  constructor(input: { readonly source: ReadOnlyLedgerSource; readonly store: LedgerMonitorStore; readonly accounting?: AccountingFinalizer }) { this.#source = input.source; this.#store = input.store; this.#accounting = input.accounting; }
  async registerExpectedSettlement(input: ExpectedSettlement): Promise<ExpectedSettlement> { return this.#store.registerExpected(input); }
  async poll(input: { readonly account: string; readonly now: string }): Promise<{ readonly scanned: number; readonly reconciled: readonly Reconciliation[]; readonly alerts: readonly TreasuryAlert[]; readonly cursor?: string }> { requireAddress(input.account, "account"); requireTime(input.now, "now"); const cursor = await this.#store.cursor(input.account); const page = await this.#source.readValidatedPayments({ account: input.account, ...(cursor ? { cursor } : {}) }); const reconciled: Reconciliation[] = []; const alerts: TreasuryAlert[] = []; for (const transaction of [...page.transactions].sort((left, right) => left.ledgerIndex - right.ledgerIndex)) { validateTransaction(transaction); if (transaction.account !== input.account || await this.#store.seen(transaction.transactionHash)) continue; const expected = await this.#store.expected(transaction.transactionHash); if (expected && matches(expected, transaction)) { const value = reconciliation(expected, transaction, input.now); if (this.#accounting) await this.#accounting.settle({ reservationId: expected.reservationId, settledAt: input.now, transactionHash: transaction.transactionHash }); reconciled.push(await this.#store.reconcile(value)); } else alerts.push(await this.#store.alert(alertFor(expected, transaction, input.now))); await this.#store.markSeen(transaction.transactionHash); } await this.#store.setCursor(input.account, page.cursor); return frozen({ scanned: page.transactions.length, reconciled: frozen(reconciled), alerts: frozen(alerts), ...(page.cursor ? { cursor: page.cursor } : {}) }); }
}

function reconciliation(expected: ExpectedSettlement, transaction: ValidatedTreasuryTransaction, now: string): Reconciliation { const base = { reconciliationId: `rec_${transaction.transactionHash.slice(0, 32).toLowerCase()}`, jobId: expected.jobId, organizationId: expected.organizationId, reservationId: expected.reservationId, transactionHash: transaction.transactionHash, ledgerIndex: transaction.ledgerIndex, reconciledAt: now }; return frozen({ ...base, digest: sha256Digest(base as unknown as CanonicalValue) }); }
function alertFor(expected: ExpectedSettlement | undefined, transaction: ValidatedTreasuryTransaction, now: string): TreasuryAlert { const code = expected ? "EXPECTED_TRANSACTION_MISMATCH" : "UNKNOWN_TREASURY_OUTFLOW"; const base = { alertId: `alert_${transaction.transactionHash.slice(0, 32).toLowerCase()}`, organizationId: expected?.organizationId ?? "org_unassigned", transactionHash: transaction.transactionHash, account: transaction.account, destination: transaction.destination, amountDrops: transaction.amountDrops, ledgerIndex: transaction.ledgerIndex, code, raisedAt: now }; return frozen({ ...base, digest: sha256Digest(base as unknown as CanonicalValue) }); }
function matches(expected: ExpectedSettlement, transaction: ValidatedTreasuryTransaction): boolean { return expected.account === transaction.account && expected.destination === transaction.destination && expected.amountDrops === transaction.amountDrops; }
function validateExpected(value: ExpectedSettlement): void { requireId(value.jobId, "jobId", "job_"); requireId(value.organizationId, "organizationId", "org_"); requireId(value.reservationId, "reservationId", "res_"); requireHash(value.transactionHash); requireAddress(value.account, "account"); requireAddress(value.destination, "destination"); requireDrops(value.amountDrops); }
function validateTransaction(value: ValidatedTreasuryTransaction): void { requireHash(value.transactionHash); if (!Number.isSafeInteger(value.ledgerIndex) || value.ledgerIndex < 1 || value.resultCode !== "tesSUCCESS") throw new LedgerMonitorError("Validated transaction is invalid."); requireAddress(value.account, "account"); requireAddress(value.destination, "destination"); requireDrops(value.amountDrops); requireTime(value.validatedAt, "validatedAt"); }
function validateReconciliation(value: Reconciliation): void { requireId(value.reconciliationId, "reconciliationId", "rec_"); requireId(value.jobId, "jobId", "job_"); requireId(value.organizationId, "organizationId", "org_"); requireId(value.reservationId, "reservationId", "res_"); requireHash(value.transactionHash); if (!Number.isSafeInteger(value.ledgerIndex) || value.ledgerIndex < 1) throw new LedgerMonitorError("Ledger index is invalid."); requireTime(value.reconciledAt, "reconciledAt"); requireDigest(value.digest); }
function validateAlert(value: TreasuryAlert): void { requireId(value.alertId, "alertId", "alert_"); requireId(value.organizationId, "organizationId", "org_"); requireHash(value.transactionHash); requireAddress(value.account, "account"); requireAddress(value.destination, "destination"); requireDrops(value.amountDrops); if (!Number.isSafeInteger(value.ledgerIndex) || value.ledgerIndex < 1 || (value.code !== "UNKNOWN_TREASURY_OUTFLOW" && value.code !== "EXPECTED_TRANSACTION_MISMATCH")) throw new LedgerMonitorError("Alert is invalid."); requireTime(value.raisedAt, "raisedAt"); requireDigest(value.digest); }
function parseAccountTransaction(value: unknown, account: string): ValidatedTreasuryTransaction | undefined { try { const entry = readRecord(value, "account_tx entry"); const transaction = readRecord(entry.tx_json ?? entry.tx, "account_tx transaction"); const meta = readRecord(entry.meta, "account_tx metadata"); const amount = transaction.Amount ?? transaction.DeliverMax; if (entry.validated !== true || transaction.TransactionType !== "Payment" || transaction.Account !== account || meta.TransactionResult !== "tesSUCCESS" || typeof amount !== "string") return undefined; const date = transaction.date; if (!Number.isSafeInteger(date)) return undefined; const parsed: ValidatedTreasuryTransaction = { transactionHash: stringHash(entry.hash ?? transaction.hash), ledgerIndex: positiveInteger(entry.ledger_index ?? transaction.ledger_index), account, destination: stringAddress(transaction.Destination), amountDrops: stringDrops(amount), resultCode: "tesSUCCESS", validatedAt: new Date((date + 946_684_800) * 1_000).toISOString() }; validateTransaction(parsed); return frozen(parsed); } catch { return undefined; } }
function parseCursor(value: string): unknown { if (value.length === 0 || value.length > 10_000) throw new LedgerMonitorError("Cursor is invalid."); try { return JSON.parse(value) as unknown; } catch { throw new LedgerMonitorError("Cursor is malformed."); } }
function readRecord(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new LedgerMonitorError(`${name} is malformed.`); return value as Record<string, unknown>; }
function stringHash(value: unknown): string { requireHash(value); return value; }
function stringAddress(value: unknown): string { requireAddress(value, "XRPL address"); return value; }
function stringDrops(value: unknown): string { requireDrops(value); return value; }
function positiveInteger(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new LedgerMonitorError("Ledger index is invalid."); return value as number; }
function message(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
function isMonitorEvent(value: unknown): value is MonitorEvent { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const event = value as Partial<MonitorEvent>; return event.contractVersion === "1.0" && typeof event.eventType === "string" && typeof event.occurredAt === "string" && typeof event.previousRecordHash === "string" && typeof event.recordHash === "string" && "value" in event; }
function genesisHash(): string { return `sha256:${"0".repeat(64)}`; }
function requireHash(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-F0-9]{64}$/.test(value)) throw new LedgerMonitorError("Transaction hash is invalid."); }
function requireAddress(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) throw new LedgerMonitorError(`${name} is invalid.`); }
function requireDrops(value: unknown): asserts value is string { if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new LedgerMonitorError("Amount drops is invalid."); }
function requireId(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new LedgerMonitorError(`${name} is invalid.`); }
function requireTime(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new LedgerMonitorError(`${name} is invalid.`); }
function requireDigest(value: unknown): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new LedgerMonitorError("Digest is invalid."); }
function frozen<T>(value: T): T { return Object.freeze(value); }
