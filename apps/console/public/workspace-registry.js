const STORAGE_KEY = 'alloc-x.workspace-registry.v1';

function cleanText(value, maximum = 160) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function makeId(prefix) {
  const token = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${token}`;
}

export function isClassicAddress(value) {
  const address = cleanText(value, 80);
  const xrplValidator = globalThis.xrpl?.isValidClassicAddress;
  if (typeof xrplValidator === 'function') return xrplValidator(address);
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

// Address checks do not establish wallet ownership, payee identity or payment authority.
// Fail closed for newly registered payees if the XRPL checksum validator did not load.
function payeeAddressStatus(value) {
  const validator = globalThis.xrpl?.isValidClassicAddress;
  if (typeof validator !== 'function') return 'CHECK_UNAVAILABLE';
  try { return validator(String(value ?? '').trim()) ? 'ADDRESS_CHECKED' : 'INVALID_ADDRESS'; }
  catch { return 'CHECK_UNAVAILABLE'; }
}

function sanitizePayees(values) {
  const names = new Set();
  const addresses = new Set();
  return values.map(sanitizePayee).filter((payee) => {
    if (!payee) return false;
    const name = payee.name.toLowerCase();
    if (names.has(name) || addresses.has(payee.walletAddress)) return false;
    names.add(name);
    addresses.add(payee.walletAddress);
    return true;
  });
}

function emptyRegistry() {
  return { version: 1, allocations: [], payees: [] };
}

function sanitizeAllocation(value) {
  if (!value || typeof value !== 'object') return null;
  const name = cleanText(value.name, 80);
  if (!name) return null;
  const walletAddress = cleanText(value.walletAddress, 80);
  return {
    allocationId: cleanText(value.allocationId, 100) || makeId('allocation'),
    name,
    category: cleanText(value.category, 60) || 'Program allocation',
    purpose: cleanText(value.purpose, 240),
    spendingRule: cleanText(value.spendingRule, 240),
    walletAddress: isClassicAddress(walletAddress) ? walletAddress : '',
    createdAt: cleanText(value.createdAt, 40) || new Date().toISOString(),
    updatedAt: cleanText(value.updatedAt, 40) || new Date().toISOString(),
  };
}

function sanitizePayee(value) {
  if (!value || typeof value !== 'object') return null;
  const name = cleanText(value.name, 100);
  const walletAddress = cleanText(value.walletAddress, 80);
  if (!name || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(walletAddress)) return null;
  const allowedTypes = new Set(['SUPPLIER', 'EMPLOYEE', 'CONTRACTOR', 'OTHER']);
  const type = cleanText(value.type, 20).toUpperCase();
  return {
    payeeId: cleanText(value.payeeId, 100) || makeId('payee'),
    name,
    type: allowedTypes.has(type) ? type : 'OTHER',
    role: cleanText(value.role, 120),
    walletAddress,
    status: payeeAddressStatus(walletAddress),
    createdAt: cleanText(value.createdAt, 40) || new Date().toISOString(),
    updatedAt: cleanText(value.updatedAt, 40) || new Date().toISOString(),
  };
}

export function readWorkspaceRegistry(storage = globalThis.localStorage) {
  if (!storage) return emptyRegistry();
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || parsed.version !== 1) return emptyRegistry();
    return {
      version: 1,
      allocations: Array.isArray(parsed.allocations) ? parsed.allocations.map(sanitizeAllocation).filter(Boolean) : [],
      payees: sanitizePayees(Array.isArray(parsed.payees) ? parsed.payees : []),
    };
  } catch {
    return emptyRegistry();
  }
}

export function writeWorkspaceRegistry(registry, storage = globalThis.localStorage) {
  const safe = {
    version: 1,
    allocations: Array.isArray(registry?.allocations) ? registry.allocations.map(sanitizeAllocation).filter(Boolean) : [],
    payees: sanitizePayees(Array.isArray(registry?.payees) ? registry.payees : []),
  };
  storage?.setItem(STORAGE_KEY, JSON.stringify(safe));
  return safe;
}

export function addAllocation(registry, input) {
  const allocation = sanitizeAllocation({ ...input, allocationId: makeId('allocation') });
  if (!allocation) throw new Error('Enter a name for this allocation.');
  if (input.walletAddress && !isClassicAddress(input.walletAddress)) throw new Error('Enter a valid XRPL classic address beginning with r.');
  if (registry.allocations.some((item) => item.name.toLowerCase() === allocation.name.toLowerCase())) throw new Error('An allocation with this name already exists.');
  return { registry: { ...registry, allocations: [...registry.allocations, allocation] }, allocation };
}

export function assignAllocationWallet(registry, allocationId, walletAddress) {
  if (!isClassicAddress(walletAddress)) throw new Error('The wallet did not return a valid XRPL classic address.');
  const now = new Date().toISOString();
  let found = false;
  const allocations = registry.allocations.map((allocation) => {
    if (allocation.allocationId !== allocationId) return allocation;
    found = true;
    return { ...allocation, walletAddress, updatedAt: now };
  });
  if (!found) throw new Error('The selected allocation no longer exists.');
  return { ...registry, allocations };
}

export function removeAllocation(registry, allocationId) {
  return { ...registry, allocations: registry.allocations.filter((item) => item.allocationId !== allocationId) };
}

export function addPayee(registry, input) {
  if (!cleanText(input.name, 100)) throw new Error('Enter the payee name.');
  const addressStatus = payeeAddressStatus(input.walletAddress);
  if (addressStatus === 'CHECK_UNAVAILABLE') throw new Error('XRPL address validation is unavailable. Reload the page before adding a payee.');
  if (addressStatus !== 'ADDRESS_CHECKED') throw new Error('Enter a valid XRPL classic address with a correct checksum.');
  const payee = sanitizePayee({ ...input, payeeId: makeId('payee') });
  if (registry.payees.some((item) => item.name.toLowerCase() === payee.name.toLowerCase())) throw new Error('A payee with this name already exists.');
  if (registry.payees.some((item) => item.walletAddress === payee.walletAddress)) throw new Error('This wallet is already registered to another payee.');
  return { registry: { ...registry, payees: [...registry.payees, payee] }, payee };
}

export function removePayee(registry, payeeId) {
  return { ...registry, payees: registry.payees.filter((item) => item.payeeId !== payeeId) };
}

export { STORAGE_KEY };
