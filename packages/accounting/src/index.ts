import {
  addDecimal,
  compareDecimal,
  parseAllocation,
  parseDecimal,
  subtractDecimal,
  type Allocation,
} from "../../contracts/src/index.ts";

export type ReservationStatus = "active" | "released" | "settled" | "expired";
export type JournalEntryType = "treasury-funded" | "reservation-created" | "reservation-released" | "reservation-expired" | "reservation-settled";

export interface TreasuryAccount {
  readonly organizationId: string;
  readonly asset: string;
  readonly authorizedAmount: string;
  readonly committedAmount: string;
  readonly settledAmount: string;
  readonly availableAmount: string;
  readonly version: number;
}

export interface AllocationAccount extends TreasuryAccount {
  readonly allocationId: string;
}

export interface AccountingReservation {
  readonly reservationId: string;
  readonly organizationId: string;
  readonly allocationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly asset: string;
  readonly amount: string;
  readonly status: ReservationStatus;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly settledAt?: string;
  readonly transactionHash?: string;
}

export interface AccountingJournalEntry {
  readonly journalEntryId: string;
  readonly organizationId: string;
  readonly allocationId?: string;
  readonly reservationId?: string;
  readonly type: JournalEntryType;
  readonly asset: string;
  readonly amount: string;
  readonly occurredAt: string;
  readonly treasuryAfter: TreasuryAccount;
  readonly allocationAfter?: AllocationAccount;
}

export interface CreateTreasuryAccount {
  readonly organizationId: string;
  readonly asset: string;
  readonly openingAmount: string;
}

export interface ReserveFunds {
  readonly reservationId: string;
  readonly organizationId: string;
  readonly allocationId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly asset: string;
  readonly amount: string;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly expectedTreasuryVersion?: number;
  readonly expectedAllocationVersion?: number;
}

export interface ReleaseReservation {
  readonly reservationId: string;
  readonly releasedAt: string;
}

export interface SettleReservation {
  readonly reservationId: string;
  readonly settledAt: string;
  readonly transactionHash: string;
}

export class InsufficientTreasuryCapacityError extends Error {
  constructor(message: string) { super(message); this.name = "InsufficientTreasuryCapacityError"; }
}
export class AccountingConcurrencyError extends Error {
  constructor(message: string) { super(message); this.name = "AccountingConcurrencyError"; }
}
export class AccountingStateError extends Error {
  constructor(message: string) { super(message); this.name = "AccountingStateError"; }
}

/**
 * Local authoritative accounting adapter. Public methods return immutable
 * snapshots and expose no direct balance mutation. A durable adapter must
 * execute the same transitions atomically in one database transaction.
 */
export class InMemoryTreasuryAccounting {
  readonly #treasuries = new Map<string, TreasuryAccount>();
  readonly #allocations = new Map<string, { allocation: Allocation; account: AllocationAccount }>();
  readonly #reservations = new Map<string, AccountingReservation>();
  readonly #journal: AccountingJournalEntry[] = [];
  #journalSequence = 0;

  createTreasuryAccount(input: CreateTreasuryAccount, occurredAt: string): TreasuryAccount {
    requireIdentifier(input.organizationId, "organizationId", "org_"); requireAsset(input.asset); requirePositive(input.openingAmount, "openingAmount"); requireTimestamp(occurredAt, "occurredAt");
    const key = treasuryKey(input.organizationId, input.asset);
    if (this.#treasuries.has(key)) throw new AccountingStateError("Treasury account already exists for organization and asset.");
    const account = frozen({ organizationId: input.organizationId, asset: input.asset, authorizedAmount: input.openingAmount, committedAmount: "0", settledAmount: "0", availableAmount: input.openingAmount, version: 1 });
    this.#treasuries.set(key, account);
    this.writeJournal({ organizationId: input.organizationId, type: "treasury-funded", asset: input.asset, amount: input.openingAmount, occurredAt, treasuryAfter: account });
    return account;
  }

  registerAllocation(input: Allocation, registeredAt: string): AllocationAccount {
    const allocation = parseAllocation(input);
    requireTimestamp(registeredAt, "registeredAt");
    if (this.#allocations.has(allocation.allocationId)) throw new AccountingStateError("Allocation is already registered.");
    if (!this.#treasuries.has(treasuryKey(allocation.organizationId, allocation.asset))) throw new AccountingStateError("A treasury account must exist before an allocation is registered.");
    const account = frozen({ organizationId: allocation.organizationId, allocationId: allocation.allocationId, asset: allocation.asset, authorizedAmount: allocation.authorizedAmount, committedAmount: "0", settledAmount: "0", availableAmount: allocation.authorizedAmount, version: 1 });
    this.#allocations.set(allocation.allocationId, { allocation, account });
    return account;
  }

  reserve(input: ReserveFunds): AccountingReservation {
    validateReservationInput(input);
    const existing = this.#reservations.get(input.reservationId);
    if (existing) return assertSameReservation(existing, input);
    const allocationState = this.#allocations.get(input.allocationId);
    if (!allocationState) throw new AccountingStateError("Allocation is not registered.");
    const allocation = allocationState.allocation;
    const allocationAccount = allocationState.account;
    if (allocation.organizationId !== input.organizationId || allocation.asset !== input.asset) throw new AccountingStateError("Reservation does not match allocation scope.");
    if (allocation.status !== "active" || Date.parse(input.reservedAt) < Date.parse(allocation.activeFrom) || Date.parse(input.reservedAt) >= Date.parse(allocation.expiresAt)) throw new AccountingStateError("Allocation is not active at reservation time.");
    if (!allocation.allowedPurposeCodes.length) throw new AccountingStateError("Allocation has no permitted purpose codes.");
    const treasury = this.treasuryFor(input.organizationId, input.asset);
    assertVersion(treasury.version, input.expectedTreasuryVersion, "treasury"); assertVersion(allocationAccount.version, input.expectedAllocationVersion, "allocation");
    if (compareDecimal(input.amount, treasury.availableAmount) > 0) throw new InsufficientTreasuryCapacityError("Treasury available balance is insufficient.");
    if (compareDecimal(input.amount, allocationAccount.availableAmount) > 0) throw new InsufficientTreasuryCapacityError("Allocation available balance is insufficient.");
    const nextTreasury = transitionReserve(treasury, input.amount); const nextAllocation = transitionReserve(allocationAccount, input.amount);
    const reservation = frozen({ reservationId: input.reservationId, organizationId: input.organizationId, allocationId: input.allocationId, intentId: input.intentId, intentDigest: input.intentDigest, asset: input.asset, amount: input.amount, status: "active" as const, reservedAt: input.reservedAt, expiresAt: input.expiresAt });
    this.#treasuries.set(treasuryKey(input.organizationId, input.asset), nextTreasury); this.#allocations.set(input.allocationId, { allocation, account: nextAllocation }); this.#reservations.set(reservation.reservationId, reservation);
    this.writeJournal({ organizationId: input.organizationId, allocationId: input.allocationId, reservationId: input.reservationId, type: "reservation-created", asset: input.asset, amount: input.amount, occurredAt: input.reservedAt, treasuryAfter: nextTreasury, allocationAfter: nextAllocation });
    this.assertInvariants(); return reservation;
  }

  release(input: ReleaseReservation): AccountingReservation {
    requireIdentifier(input.reservationId, "reservationId", "res_"); requireTimestamp(input.releasedAt, "releasedAt");
    const reservation = this.reservationFor(input.reservationId);
    if (reservation.status === "released" || reservation.status === "expired") return reservation;
    if (reservation.status === "settled") throw new AccountingStateError("A settled reservation cannot be released.");
    return this.closeReservation(reservation, "released", input.releasedAt);
  }

  expireReservations(now: string): readonly AccountingReservation[] {
    requireTimestamp(now, "now"); const expired: AccountingReservation[] = [];
    for (const reservation of this.#reservations.values()) if (reservation.status === "active" && Date.parse(reservation.expiresAt) <= Date.parse(now)) expired.push(this.closeReservation(reservation, "expired", now));
    return frozen(expired);
  }

  settle(input: SettleReservation): AccountingReservation {
    requireIdentifier(input.reservationId, "reservationId", "res_"); requireTimestamp(input.settledAt, "settledAt"); requireTransactionHash(input.transactionHash);
    const reservation = this.reservationFor(input.reservationId);
    if (reservation.status === "settled") {
      if (reservation.transactionHash === input.transactionHash) return reservation;
      throw new AccountingStateError("A settled reservation cannot be associated with another transaction.");
    }
    if (reservation.status !== "active") throw new AccountingStateError("Only an active reservation can settle.");
    if (Date.parse(input.settledAt) > Date.parse(reservation.expiresAt)) throw new AccountingStateError("Expired reservations cannot settle.");
    const treasury = this.treasuryFor(reservation.organizationId, reservation.asset); const allocationState = this.allocationFor(reservation.allocationId);
    const nextTreasury = transitionSettle(treasury, reservation.amount); const nextAllocation = transitionSettle(allocationState.account, reservation.amount);
    const settled = frozen({ ...reservation, status: "settled" as const, settledAt: input.settledAt, transactionHash: input.transactionHash });
    this.#treasuries.set(treasuryKey(reservation.organizationId, reservation.asset), nextTreasury); this.#allocations.set(reservation.allocationId, { allocation: allocationState.allocation, account: nextAllocation }); this.#reservations.set(reservation.reservationId, settled);
    this.writeJournal({ organizationId: reservation.organizationId, allocationId: reservation.allocationId, reservationId: reservation.reservationId, type: "reservation-settled", asset: reservation.asset, amount: reservation.amount, occurredAt: input.settledAt, treasuryAfter: nextTreasury, allocationAfter: nextAllocation });
    this.assertInvariants(); return settled;
  }

  treasurySnapshot(organizationId: string, asset: string): TreasuryAccount { return this.treasuryFor(organizationId, asset); }
  allocationSnapshot(organizationId: string, allocationId: string): AllocationAccount { const state = this.allocationFor(allocationId); if (state.account.organizationId !== organizationId) throw new AccountingStateError("Allocation belongs to another organization."); return state.account; }
  reservationSnapshot(reservationId: string): AccountingReservation { return this.reservationFor(reservationId); }
  journal(organizationId: string): readonly AccountingJournalEntry[] { requireIdentifier(organizationId, "organizationId", "org_"); return frozen(this.#journal.filter((entry) => entry.organizationId === organizationId)); }

  assertInvariants(): void {
    for (const treasury of this.#treasuries.values()) assertBalanceInvariant(treasury);
    for (const state of this.#allocations.values()) assertBalanceInvariant(state.account);
    for (const reservation of this.#reservations.values()) {
      if (reservation.status === "active" && Date.parse(reservation.expiresAt) <= Date.parse(reservation.reservedAt)) throw new AccountingStateError("Active reservation has invalid time window.");
    }
    for (const treasury of this.#treasuries.values()) {
      const active = sum(this.#reservations.values(), treasury.organizationId, treasury.asset, "active"); const settled = sum(this.#reservations.values(), treasury.organizationId, treasury.asset, "settled");
      if (active !== treasury.committedAmount || settled !== treasury.settledAmount) throw new AccountingStateError("Treasury reservation totals do not match balances.");
    }
    for (const [allocationId, state] of this.#allocations) {
      const active = sum(this.#reservations.values(), state.account.organizationId, state.account.asset, "active", allocationId); const settled = sum(this.#reservations.values(), state.account.organizationId, state.account.asset, "settled", allocationId);
      if (active !== state.account.committedAmount || settled !== state.account.settledAmount) throw new AccountingStateError("Allocation reservation totals do not match balances.");
    }
  }

  private closeReservation(reservation: AccountingReservation, status: "released" | "expired", occurredAt: string): AccountingReservation {
    const treasury = this.treasuryFor(reservation.organizationId, reservation.asset); const allocationState = this.allocationFor(reservation.allocationId);
    const nextTreasury = transitionRelease(treasury, reservation.amount); const nextAllocation = transitionRelease(allocationState.account, reservation.amount);
    const closed = frozen({ ...reservation, status, releasedAt: occurredAt });
    this.#treasuries.set(treasuryKey(reservation.organizationId, reservation.asset), nextTreasury); this.#allocations.set(reservation.allocationId, { allocation: allocationState.allocation, account: nextAllocation }); this.#reservations.set(reservation.reservationId, closed);
    this.writeJournal({ organizationId: reservation.organizationId, allocationId: reservation.allocationId, reservationId: reservation.reservationId, type: status === "expired" ? "reservation-expired" : "reservation-released", asset: reservation.asset, amount: reservation.amount, occurredAt, treasuryAfter: nextTreasury, allocationAfter: nextAllocation });
    this.assertInvariants(); return closed;
  }
  private treasuryFor(organizationId: string, asset: string): TreasuryAccount { requireIdentifier(organizationId, "organizationId", "org_"); requireAsset(asset); const value = this.#treasuries.get(treasuryKey(organizationId, asset)); if (!value) throw new AccountingStateError("Treasury account is not registered."); return value; }
  private allocationFor(allocationId: string): { allocation: Allocation; account: AllocationAccount } { requireIdentifier(allocationId, "allocationId", "alloc_"); const value = this.#allocations.get(allocationId); if (!value) throw new AccountingStateError("Allocation is not registered."); return value; }
  private reservationFor(reservationId: string): AccountingReservation { requireIdentifier(reservationId, "reservationId", "res_"); const value = this.#reservations.get(reservationId); if (!value) throw new AccountingStateError("Reservation is not registered."); return value; }
  private writeJournal(entry: Omit<AccountingJournalEntry, "journalEntryId">): void { this.#journalSequence += 1; this.#journal.push(frozen({ ...entry, journalEntryId: `journal_${this.#journalSequence.toString().padStart(12, "0")}` })); }
}

function transitionReserve<T extends TreasuryAccount>(account: T, amount: string): T { return next(account, addDecimal(account.committedAmount, amount), account.settledAmount); }
function transitionRelease<T extends TreasuryAccount>(account: T, amount: string): T { return next(account, subtractDecimal(account.committedAmount, amount), account.settledAmount); }
function transitionSettle<T extends TreasuryAccount>(account: T, amount: string): T { return next(account, subtractDecimal(account.committedAmount, amount), addDecimal(account.settledAmount, amount)); }
function next<T extends TreasuryAccount>(account: T, committedAmount: string, settledAmount: string): T { const availableAmount = subtractDecimal(subtractDecimal(account.authorizedAmount, committedAmount), settledAmount); return frozen({ ...account, committedAmount, settledAmount, availableAmount, version: account.version + 1 }); }
function sum(reservations: Iterable<AccountingReservation>, organizationId: string, asset: string, status: ReservationStatus, allocationId?: string): string { let total = "0"; for (const reservation of reservations) if (reservation.organizationId === organizationId && reservation.asset === asset && reservation.status === status && (allocationId === undefined || reservation.allocationId === allocationId)) total = addDecimal(total, reservation.amount); return total; }
function assertBalanceInvariant(account: TreasuryAccount): void { const expected = subtractDecimal(subtractDecimal(account.authorizedAmount, account.committedAmount), account.settledAmount); if (expected !== account.availableAmount || compareDecimal(expected, "0") < 0) throw new AccountingStateError("Accounting balance invariant failed."); }
function assertVersion(actual: number, expected: number | undefined, account: string): void { if (expected !== undefined && actual !== expected) throw new AccountingConcurrencyError(`${account} version is stale.`); }
function assertSameReservation(existing: AccountingReservation, input: ReserveFunds): AccountingReservation { const same = existing.organizationId === input.organizationId && existing.allocationId === input.allocationId && existing.intentId === input.intentId && existing.intentDigest === input.intentDigest && existing.asset === input.asset && existing.amount === input.amount && existing.reservedAt === input.reservedAt && existing.expiresAt === input.expiresAt; if (!same) throw new AccountingStateError("reservationId was reused for a different reservation."); return existing; }
function validateReservationInput(input: ReserveFunds): void { requireIdentifier(input.reservationId, "reservationId", "res_"); requireIdentifier(input.organizationId, "organizationId", "org_"); requireIdentifier(input.allocationId, "allocationId", "alloc_"); requireIdentifier(input.intentId, "intentId", "pi_"); requireDigest(input.intentDigest, "intentDigest"); requireAsset(input.asset); requirePositive(input.amount, "amount"); requireTimestamp(input.reservedAt, "reservedAt"); requireTimestamp(input.expiresAt, "expiresAt"); if (Date.parse(input.expiresAt) <= Date.parse(input.reservedAt)) throw new AccountingStateError("expiresAt must be after reservedAt."); }
function treasuryKey(organizationId: string, asset: string): string { return `${organizationId}:${asset}`; }
function requireIdentifier(value: unknown, name: string, prefix: string): asserts value is string { if (typeof value !== "string" || !value.startsWith(prefix) || !/^[a-z][a-z0-9_-]{2,119}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireAsset(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9-]{3,80}$/.test(value)) throw new TypeError("asset is invalid."); }
function requirePositive(value: unknown, name: string): asserts value is string { if (typeof value !== "string") throw new TypeError(`${name} must be a decimal string.`); if (parseDecimal(value).coefficient <= 0n) throw new TypeError(`${name} must be positive.`); }
function requireTimestamp(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid.`); }
function requireDigest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} is invalid.`); }
function requireTransactionHash(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-F0-9]{64}$/.test(value)) throw new TypeError("transactionHash is invalid."); }
function frozen<T>(value: T): T { return Object.freeze(value); }
