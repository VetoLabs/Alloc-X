import { addAllocation, addPayee, assignAllocationWallet, isClassicAddress, readWorkspaceRegistry, removeAllocation, removePayee, writeWorkspaceRegistry } from './workspace-registry.js';

const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  payment: '<path d="M4 7h16M7 3l-3 4 3 4M17 13l3 4-3 4M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  audit: '<path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
  funds: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M7 15h3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10 21h4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H20v14H6.5A2.5 2.5 0 0 1 4 16.5v-9Z"/><path d="M4 9h16M15 14h2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  alert: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 1 0 1 5M20 5v6h-6"/>',
  agent: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
};

const state = { data: null, route: 'overview', activePaymentId: null, activeBeneficiaryId: null, agentSession: null, voiceInstruction: null, voiceState: 'IDLE', voiceTranscript: '', voiceConfidence: undefined, busy: false, mobileMenuOpen: false, walletPickerOpen: false, walletInstallProvider: null, walletConnecting: null, pendingAllocationWalletId: null, registryDialog: null, registry: readWorkspaceRegistry(), allocationBalances: {}, wallet: { status: 'DISCONNECTED', account: null, name: null, balance: null, error: null } };
const routes = {
  overview: { label: 'Overview', icon: 'grid' },
  allocations: { label: 'Allocations', icon: 'funds' },
  payments: { label: 'Payments', icon: 'payment' },
  'new-payment': { label: 'New payment', icon: 'plus' },
  agent: { label: 'Allocation agent', icon: 'agent' },
  forecast: { label: 'Cash runway', icon: 'funds' },
  schedule: { label: 'Payment plan', icon: 'clock' },
  beneficiaries: { label: 'Payees', icon: 'users' },
  security: { label: 'Security', icon: 'shield' },
  audit: { label: 'Audit trail', icon: 'audit' },
  operations: { label: 'Operations', icon: 'alert' },
  activation: { label: 'Mainnet readiness', icon: 'lock' },
  'offline-trust': { label: 'Offline trust', icon: 'wallet' },
  'offline-sync': { label: 'Offline sync', icon: 'refresh' },
  'offline-revalidation': { label: 'Online revalidation', icon: 'shield' },
  'organization-capabilities': { label: 'Organization model', icon: 'users' },
  'commercial-controls': { label: 'Commercial controls', icon: 'funds' },
  'nonprofit-controls': { label: 'Program controls', icon: 'funds' },
  'public-sector-controls': { label: 'Public controls', icon: 'audit' },
};

const app = document.querySelector('#app');
let walletManager;

function initializeWalletConnection() {
  const sdk = globalThis.XRPLConnect;
  if (!sdk?.WalletManager || !sdk?.CrossmarkAdapter || !sdk?.GemWalletAdapter) {
    state.wallet = { status: 'UNAVAILABLE', account: null, name: null, balance: null, error: 'XRPL Connect did not load.' };
    return;
  }
  walletManager = new sdk.WalletManager({ adapters: [new sdk.GemWalletAdapter(), new sdk.CrossmarkAdapter()], network: 'testnet', autoConnect: true, logger: { level: 'warn', prefix: '[Alloc-X wallet]' } });
  walletManager.on('connect', (account) => walletConnected(account));
  walletManager.on('accountChanged', (account) => walletConnected(account));
  walletManager.on('networkChanged', () => refreshWalletBalance());
  walletManager.on('disconnect', () => { state.wallet = { status: 'DISCONNECTED', account: null, name: null, balance: null, error: null }; if (state.data) render(); });
}

async function walletConnected(account) {
  state.walletPickerOpen = false;
  state.walletInstallProvider = null;
  state.wallet = { status: 'VERIFYING', account: account.address, name: walletManager?.wallet?.name || 'XRPL wallet', balance: null, error: null };
  completePendingAllocationWallet(account.address);
  if (state.data) render();
  await refreshWalletBalance();
}

function operatorAccount() {
  return walletManager?.account || (state.wallet.account ? { address: state.wallet.account, network: { id: state.wallet.network || 'testnet' } } : null);
}

async function refreshWalletBalance() {
  const account = operatorAccount();
  if (!account) return;
  if (account.network?.id !== 'testnet') {
    state.wallet = { status: 'UNSUPPORTED', account: account.address, name: walletManager?.wallet?.name || 'XRPL wallet', balance: null, error: 'Select an XRPL Testnet account to view its ledger balance.' };
    if (state.data) render();
    return;
  }
  state.wallet = { ...state.wallet, status: 'VERIFYING', account: account.address, name: walletManager?.wallet?.name || 'XRPL wallet', error: null };
  if (state.data) render();
  try {
    const balance = await api(`/api/xrpl/testnet/accounts/${encodeURIComponent(account.address)}`);
    if (operatorAccount()?.address !== account.address) return;
    state.wallet = { status: 'CONNECTED', account: account.address, name: state.wallet.name || walletManager?.wallet?.name || 'XRPL wallet', network: 'testnet', balance, error: null };
  } catch (error) {
    if (operatorAccount()?.address !== account.address) return;
    state.wallet = { status: 'BALANCE_UNAVAILABLE', account: account.address, name: state.wallet.name || walletManager?.wallet?.name || 'XRPL wallet', network: 'testnet', balance: null, error: error.message };
  }
  if (state.data) render();
}

function completePendingAllocationWallet(address) {
  if (!state.pendingAllocationWalletId) return;
  try {
    state.registry = assignAllocationWallet(state.registry, state.pendingAllocationWalletId, address);
    state.registry = writeWorkspaceRegistry(state.registry);
    const allocation = state.registry.allocations.find((item) => item.allocationId === state.pendingAllocationWalletId);
    state.pendingAllocationWalletId = null;
    toast('Allocation wallet connected', `${allocation?.name || 'Allocation'} now uses ${compact(address)}.`);
    refreshAllocationBalances();
  } catch (error) {
    state.pendingAllocationWalletId = null;
    toast('Wallet could not be assigned', error.message, true);
  }
}

async function connectGemWalletDirect() {
  const gem = globalThis.XRPLConnect?.GemWalletAPI;
  if (!gem?.getAddress || !gem?.getNetwork) throw new Error('GemWallet support did not load.');
  const installed = await gem.isInstalled?.();
  if (installed?.result?.isInstalled === false) {
    const error = new Error('GemWallet was not detected in this browser.');
    error.code = 'WALLET_NOT_INSTALLED';
    throw error;
  }
  const [addressResponse, networkResponse] = await Promise.all([gem.getAddress(), gem.getNetwork()]);
  const address = addressResponse?.result?.address || addressResponse?.publicAddress || addressResponse?.address;
  const rawNetwork = networkResponse?.result?.network || networkResponse?.network;
  const network = String(rawNetwork || '').toLowerCase();
  if (!isClassicAddress(address)) throw new Error('GemWallet did not return a valid XRPL account. Unlock the extension and try again.');
  if (network !== 'testnet') throw new Error(`GemWallet is on ${rawNetwork || 'an unknown network'}. Select Testnet and try again.`);
  state.walletPickerOpen = false;
  state.wallet = { status: 'VERIFYING', account: address, name: 'GemWallet', network: 'testnet', balance: null, error: null };
  completePendingAllocationWallet(address);
  render();
  await refreshWalletBalance();
  return { address, network: { id: 'testnet' } };
}

function svg(name, className = '') { return `<svg class="${className || 'nav-icon'}" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`; }
function logo() {
  return `<span class="mark"><img src="/alloc-x-logo.jpg" alt="Alloc-X protected allocation mark"></span>`;
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function money(value) { return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} XRP`; }
function compact(value) { return `${String(value).slice(0, 14)}…${String(value).slice(-8)}`; }
function when(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function outcomeClass(outcome) { return outcome === 'ALLOW' ? 'allow' : outcome === 'REVIEW' ? 'review' : 'block'; }
function status(outcome, label = outcome) { return `<span class="status ${outcomeClass(outcome)}">${esc(label)}</span>`; }
function button(label, action, style = 'secondary', attrs = '') { return `<button class="button ${style}" type="button" data-action="${action}" ${attrs}>${label}</button>`; }

async function load() {
  app.innerHTML = `<main class="loading"><span class="loader"></span><span>Opening your secure workspace…</span></main>`;
  try {
    state.data = await api('/api/bootstrap');
    render();
    refreshAllocationBalances();
  } catch (error) {
    app.innerHTML = `<main class="loading"><div><strong>Unable to open Alloc-X.</strong><p>${esc(error.message)}</p>${button('Try again', 'reload', 'primary')}</div></main>`;
    bind();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function showLanding() {
  app.innerHTML = `<main class="landing" aria-labelledby="landing-title"><div class="landing-orbit orbit-one"></div><div class="landing-orbit orbit-two"></div><div class="landing-content"><img class="landing-logo" src="/alloc-x-logo.jpg" alt="Alloc-X mark"><h1 id="landing-title">Alloc-X</h1><p>Trusted allocation. Protected execution.</p><button class="landing-button" type="button" data-action="enter-workspace">Enter workspace <span aria-hidden="true">→</span></button></div></main>`;
  bind();
}

function enterWorkspace() {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  app.innerHTML = `<main class="launch-film${reducedMotion ? ' reduced-motion' : ''}" aria-live="polite" aria-label="Opening Alloc-X workspace"><div class="launch-grid"></div><div class="launch-rings"></div><img class="launch-logo" src="/alloc-x-logo.jpg" alt=""><div class="launch-copy"><span>Alloc-X</span><strong>Preparing your secure workspace</strong></div></main>`;
  window.setTimeout(load, reducedMotion ? 650 : 1700);
}

function render() {
  const data = state.data;
  app.innerHTML = `<div class="shell${state.mobileMenuOpen ? ' nav-open' : ''}">
    <aside class="sidebar" aria-label="Primary navigation">
      <a class="brand" href="#overview" data-route="overview">${logo()}<span class="brand-name">Alloc-X<small>Trusted allocation</small></span></a>
      <div class="nav-label">Workspace</div>
      <nav class="nav">${nav(['overview', 'allocations', 'beneficiaries', 'payments', 'new-payment', 'agent', 'forecast', 'schedule'])}</nav>
      <div class="nav-label">Assurance</div>
      <nav class="nav">${nav(['security', 'audit', 'operations', 'activation', 'offline-trust', 'offline-sync', 'offline-revalidation', 'organization-capabilities', 'commercial-controls', 'nonprofit-controls', 'public-sector-controls'])}</nav>
      <div class="sidebar-bottom"><div class="secure-state"><i class="secure-dot"></i>${esc(data.organization.environment)}</div><div class="identity"><span class="avatar">TO</span><span><strong>${esc(data.operator.name)}</strong><span>${esc(data.operator.role)}</span></span></div></div>
    </aside>
    <button class="nav-scrim" type="button" data-action="mobile-menu" aria-label="Close navigation menu"></button>
    <section class="workspace">
      <header class="topbar"><div class="crumb"><span>${esc(data.organization.displayName)}</span><span>›</span><strong>${esc(routes[state.route]?.label || 'Payment details')}</strong></div><div class="topbar-spacer"></div>${walletControl()}<button class="wallet-launch" type="button" data-action="wallet-connect">${state.wallet.account ? 'Switch wallet' : 'Connect XRPL wallet'}</button><span class="env-badge"><i></i>XRPL Testnet</span><button class="icon-button" aria-label="Refresh workspace" data-action="reload">${svg('refresh')}</button><button class="icon-button" aria-label="Notifications">${svg('bell')}</button></header>
      <main class="page" id="main-content">${page()}</main>
    </section>
    ${walletPicker()}
    ${registryDialog()}
    <nav class="mobile-nav" aria-label="Mobile navigation">${nav(['overview', 'allocations', 'beneficiaries', 'payments'])}<button class="nav-button mobile-more${state.mobileMenuOpen ? ' active' : ''}" type="button" data-action="mobile-menu" aria-label="${state.mobileMenuOpen ? 'Close' : 'Open'} full menu" aria-expanded="${state.mobileMenuOpen}">${svg('menu')}<span>More</span></button></nav>
  </div>`;
  bind();
}

function walletControl() {
  const wallet = state.wallet;
  if (wallet.status === 'CONNECTED') return `<div class="wallet-control"><button class="wallet-status" type="button" data-action="wallet-refresh" title="Refresh validated Testnet balance"><i></i><span><strong>${esc(wallet.name)}</strong><small>${esc(compact(wallet.account))}</small></span></button><button class="wallet-disconnect" type="button" data-action="wallet-disconnect">Disconnect</button></div>`;
  if (wallet.status === 'VERIFYING') return `<button class="wallet-status checking" type="button" disabled><span class="loader"></span><span><strong>Verifying Testnet wallet</strong><small>${esc(wallet.account ? compact(wallet.account) : 'Reading validated ledger')}</small></span></button>`;
  if (['ERROR', 'UNSUPPORTED', 'BALANCE_UNAVAILABLE'].includes(wallet.status)) return `<button class="wallet-status checking" type="button" data-action="wallet-refresh" title="${esc(wallet.error || 'Balance not yet available')}"><span>${svg('wallet')}</span><span><strong>${wallet.status === 'UNSUPPORTED' ? 'Select XRPL Testnet' : 'Wallet connected'}</strong><small>${esc(wallet.account ? compact(wallet.account) : 'No account selected')}</small></span></button>`;
  return '';
}

function walletPicker() {
  if (!state.walletPickerOpen) return '';
  const provider = state.walletInstallProvider;
  const name = provider === 'crossmark' ? 'Crossmark' : 'GemWallet';
  const installUrl = provider === 'crossmark' ? 'https://crossmark.io/' : 'https://chromewebstore.google.com/detail/gemwallet/egebedonbdapoieedfcfkofloclfghab';
  const installHelp = provider
    ? '<div class="wallet-picker-notice" role="status"><strong>' + name + ' was not detected in this browser.</strong><span>Install and unlock the extension, select XRPL Testnet, then click ' + name + ' again. No transaction will be sent by connecting.</span><a href="' + installUrl + '" target="_blank" rel="noopener noreferrer">Visit ' + name + ' website ↗</a></div>'
    : '';
  return '<div class="wallet-picker-backdrop"><section class="wallet-picker" role="dialog" aria-modal="true" aria-labelledby="wallet-picker-title">' +
    '<div class="wallet-picker-heading"><div><p class="eyebrow">XRP Ledger · Testnet</p><h2 id="wallet-picker-title">Connect your XRPL wallet</h2><p>Choose an XRPL-compatible wallet. No EVM wallet or private key is required.</p></div>' +
    '<button type="button" class="wallet-picker-close" data-action="wallet-modal-close" aria-label="Close wallet selector">×</button></div>' +
    '<div class="wallet-picker-options">' +
      '<button type="button" class="wallet-picker-option" data-action="wallet-select" data-wallet-id="gemwallet" ' + (state.walletConnecting ? 'disabled' : '') + '><span class="wallet-picker-icon gem">◆</span><span><strong>GemWallet <em>Recommended</em></strong><small>XRPL browser extension · Testnet</small></span><span class="wallet-picker-arrow">›</span></button>' +
      '<button type="button" class="wallet-picker-option" data-action="wallet-select" data-wallet-id="crossmark" ' + (state.walletConnecting ? 'disabled' : '') + '><span class="wallet-picker-icon crossmark">✦</span><span><strong>Crossmark</strong><small>XRPL extension · legacy support</small></span><span class="wallet-picker-arrow">›</span></button>' +
    '</div>' + installHelp +
    '<p class="wallet-picker-footnote">Wallet connection is for viewing an XRPL account and approved user actions; autonomous treasury payments require an independently protected agent signer.</p>' +
    '</section></div>';
}

function nav(items) { return items.map((route) => `<button class="nav-button ${state.route === route ? 'active' : ''}" type="button" data-route="${route}">${svg(routes[route].icon)}<span>${routes[route].label}</span></button>`).join(''); }
function page() {
  if (state.route === 'overview') return overview();
  if (state.route === 'allocations') return allocationWorkspace();
  if (state.route === 'payments') return payments();
  if (state.route === 'new-payment') return newPayment();
  if (state.route === 'agent') return agentWorkspace();
  if (state.route === 'forecast') return cashRunway();
  if (state.route === 'schedule') return paymentPlan();
  if (state.route === 'beneficiaries') return beneficiaryWorkspace();
  if (state.route === 'security') return securityConsole();
  if (state.route === 'audit') return audit();
  if (state.route === 'operations') return operations();
  if (state.route === 'activation') return mainnetReadiness();
  if (state.route === 'offline-trust') return offlineTrust();
  if (state.route === 'offline-sync') return offlineSync();
  if (state.route === 'offline-revalidation') return offlineRevalidation();
  if (state.route === 'organization-capabilities') return organizationCapabilities();
  if (state.route === 'commercial-controls') return commercialControls();
  if (state.route === 'nonprofit-controls') return nonprofitControls();
  if (state.route === 'public-sector-controls') return publicSectorControls();
  if (state.route === 'payment-detail') return paymentDetail();
  if (state.route === 'beneficiary-detail') return beneficiaryDetail();
  return overview();
}

function overview() {
  const { payments, securityJournal } = state.data;
  const allowed = payments.filter((payment) => payment.decision.decision.outcome === 'ALLOW').length;
  const review = payments.filter((payment) => payment.decision.decision.outcome === 'REVIEW').length;
  const allocations = state.registry.allocations;
  const linked = allocations.filter((allocation) => allocation.walletAddress);
  const balances = linked.map((allocation) => state.allocationBalances[allocation.allocationId]).filter((balance) => balance?.status === 'READY');
  const liveBalance = balances.length ? money(balances.reduce((total, balance) => total + Number(balance.balanceXrp), 0)) : '—';
  return `<section class="page-heading command-heading"><div><p class="eyebrow">Treasury command centre</p><h1>Welcome to Alloc-X.</h1><p>Alloc-X has checked treasury capacity, policy health, and payments that need attention.</p></div>${button(`${svg('plus', 'nav-icon')} Create payment`, 'route-new-payment', 'primary')}</section>
    <section class="agent-prompt" aria-labelledby="agent-prompt-title"><div class="agent-prompt-icon">${svg('agent')}</div><form id="agent-form" class="agent-prompt-form"><label id="agent-prompt-title" for="agentMessage">What should Alloc-X handle?</label><input id="agentMessage" name="message" maxlength="500" required autocomplete="off" placeholder="Ask me to pay, plan, explain a decision, or check an allocation…"><span>Only approved records and the protected workflow can create a payment.</span></form><div class="prompt-actions"><button class="mic-button ${state.voiceState === 'LISTENING' ? 'listening' : ''}" type="button" data-action="voice-toggle" aria-label="${state.voiceState === 'LISTENING' ? 'Stop listening' : 'Give a voice instruction'}" aria-pressed="${state.voiceState === 'LISTENING'}">${svg('mic')}</button><button class="button agent-prompt-button" form="agent-form" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Working…' : `Ask Alloc-X ${svg('arrow', 'nav-icon')}`}</button></div></section>${voicePanel()}
    <div class="grid four command-metrics"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Validated treasury balance</span><span class="metric-icon">${svg('wallet')}</span></div><div class="metric-value">${liveBalance}</div><span class="metric-sub ${balances.length ? 'positive' : ''}">${balances.length ? `Across ${balances.length} live Testnet source${balances.length === 1 ? '' : 's'}` : 'Add an allocation wallet to read live funds'}</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Allocation wallets</span><span class="metric-icon">${svg('funds')}</span></div><div class="metric-value">${linked.length}</div><span class="metric-sub">${allocations.length} allocation${allocations.length === 1 ? '' : 's'} registered</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Registered payees</span><span class="metric-icon">${svg('users')}</span></div><div class="metric-value">${state.registry.payees.length}</div><span class="metric-sub">Suppliers, employees and other recipients</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Needs attention</span><span class="metric-icon">${svg('bell')}</span></div><div class="metric-value">${review}</div><span class="metric-sub">${allowed} signed allow decision${allowed === 1 ? '' : 's'}</span></article></div>
    <div class="grid two command-grid"><section class="card pad allocation-card"><div class="card-heading"><div><h2>Live allocation wallets</h2><p>Each source keeps its own purpose and XRPL Testnet balance.</p></div>${button('Manage allocations', 'route-allocations')}</div>${allocations.length ? allocations.slice(0, 4).map(allocationSummaryRow).join('') : empty('wallet', 'No allocation wallets yet', 'Create Education, Healthcare, Infrastructure, payroll, or any other allocation your organization needs.')}</section><section class="card pad security-panel command-security"><div class="card-heading"><div><p class="security-kicker">Approval layer</p><h2>Controls are active</h2><p>Every decision is signed before it can move forward.</p></div>${status('ALLOW', 'Operational')}</div><div class="control"><span class="control-icon">${svg('check')}</span><div><b>Identity and tenant checks</b><span>Server-side service assertion required</span></div></div><div class="control"><span class="control-icon">${svg('lock')}</span><div><b>Policy and evidence gates</b><span>Deterministic evaluation with reason codes</span></div></div><div class="control"><span class="control-icon">${svg('audit')}</span><div><b>Durable decision journal</b><span>${securityJournal.valid ? 'Hash chain verified' : 'Verification attention required'}</span></div></div></section></div>
    <section class="card pad recent-activity"><div class="card-heading"><div><h2>Recent payment activity</h2><p>Outcomes come from recorded signed decisions.</p></div>${button('View all payments', 'route-payments')}</div>${payments.length ? paymentTable(payments.slice(0, 5)) : empty('receipt', 'No payments yet', 'Create a payment from authoritative references. The browser never supplies a destination or amount.')}</section>`;
}

function allocationCard(allocation) { const used = Math.max(0, Number(allocation.authorizedAmount) - Number(allocation.availableAmount)); const percent = Math.min(100, (used / Number(allocation.authorizedAmount)) * 100); return `<div class="allocation-item"><div style="min-width:0;flex:1"><div class="row"><span class="allocation-name">${esc(allocation.allocationId === 'alloc_clinic' ? 'Clinic equipment' : 'Field operations')}</span><span class="amount">${money(allocation.availableAmount)}</span></div><div class="allocation-meta">${money(allocation.committedAmount)} committed · ${money(allocation.settledAmount)} settled</div><div class="progress"><span style="width:${percent}%"></span></div></div></div>`; }

function allocationSummaryRow(allocation) {
  const balance = state.allocationBalances[allocation.allocationId];
  const value = !allocation.walletAddress ? 'Wallet not linked' : balance?.status === 'READY' ? money(balance.balanceXrp) : balance?.status === 'ERROR' ? 'Balance unavailable' : 'Reading Testnet…';
  return `<div class="allocation-item"><div class="allocation-symbol">${esc(allocation.name.slice(0, 2).toUpperCase())}</div><div class="allocation-summary"><div class="allocation-name">${esc(allocation.name)}</div><div class="allocation-meta">${esc(allocation.category)}${allocation.walletAddress ? ` · ${esc(compact(allocation.walletAddress))}` : ''}</div></div><strong class="allocation-live-value">${esc(value)}</strong></div>`;
}

function allocationWorkspace() {
  const allocations = state.registry.allocations;
  const linked = allocations.filter((item) => item.walletAddress).length;
  return `<section class="page-heading"><div><p class="eyebrow">Treasury management</p><h1>Allocation wallets</h1><p>Create as many purpose-bound funding sections as your organization needs. Each allocation retains its own name, rules, XRPL Testnet address, and live balance.</p></div>${button(`${svg('plus', 'nav-icon')} Add allocation`, 'add-allocation', 'primary')}</section>
    <div class="grid three registry-metrics"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Allocations</span><span class="metric-icon">${svg('funds')}</span></div><div class="metric-value">${allocations.length}</div><span class="metric-sub">No fixed limit</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Wallets linked</span><span class="metric-icon">${svg('wallet')}</span></div><div class="metric-value">${linked}</div><span class="metric-sub">Independent Testnet sources</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Awaiting wallet</span><span class="metric-icon">${svg('alert')}</span></div><div class="metric-value">${allocations.length - linked}</div><span class="metric-sub">Can be linked at any time</span></article></div>
    <div class="banner registry-banner">${svg('shield')}<div><strong>One wallet connection does not replace another</strong>Connect or register a public XRPL address against each allocation. Alloc-X keeps every funding source separate so the agent can later choose the eligible source by purpose and policy.</div></div>
    ${allocations.length ? `<section class="registry-grid">${allocations.map(allocationRegistryCard).join('')}<button class="registry-add-card" type="button" data-action="add-allocation">${svg('plus')}<strong>Add another allocation</strong><span>Education, healthcare, infrastructure, payroll, sport, or any other purpose</span></button></section>` : `<section class="card pad registry-empty">${empty('funds', 'Create your first allocation', 'Start with the program, department, grant, or public allocation you want Alloc-X to manage.')}<button class="button primary" type="button" data-action="add-allocation">${svg('plus', 'nav-icon')} Add first allocation</button></section>`}`;
}

function allocationRegistryCard(allocation) {
  const balance = state.allocationBalances[allocation.allocationId];
  const linked = Boolean(allocation.walletAddress);
  const balanceCopy = !linked ? 'Wallet not linked' : balance?.status === 'READY' ? money(balance.balanceXrp) : balance?.status === 'ERROR' ? 'Balance unavailable' : 'Reading validated ledger…';
  return `<article class="card registry-card"><div class="registry-card-top"><span class="allocation-symbol large">${esc(allocation.name.slice(0, 2).toUpperCase())}</span><div class="registry-card-status">${linked && balance?.status === 'READY' ? status('ALLOW', 'Live') : status('REVIEW', linked ? 'Checking' : 'Needs wallet')}</div></div><p class="registry-type">${esc(allocation.category)}</p><h2>${esc(allocation.name)}</h2><p class="registry-purpose">${esc(allocation.purpose || 'Purpose rules can be added when the allocation policy is configured.')}</p><div class="registry-balance"><span>XRPL Testnet balance</span><strong>${esc(balanceCopy)}</strong>${linked ? `<small>${esc(compact(allocation.walletAddress))}</small>` : '<small>No address registered</small>'}</div>${allocation.spendingRule ? `<div class="registry-rule">${svg('lock')}<span>${esc(allocation.spendingRule)}</span></div>` : ''}<div class="registry-actions"><button class="button secondary" type="button" data-action="connect-allocation-wallet" data-allocation-id="${esc(allocation.allocationId)}">${linked ? 'Change wallet' : 'Connect wallet'}</button>${linked ? `<button class="icon-button" type="button" data-action="refresh-allocation" data-allocation-id="${esc(allocation.allocationId)}" aria-label="Refresh ${esc(allocation.name)} balance">${svg('refresh')}</button>` : ''}<button class="icon-button danger-icon" type="button" data-action="remove-allocation" data-allocation-id="${esc(allocation.allocationId)}" aria-label="Remove ${esc(allocation.name)}">${svg('trash')}</button></div></article>`;
}

function registryDialog() {
  if (state.registryDialog === 'allocation') return `<div class="modal-backdrop"><section class="modal registry-dialog" role="dialog" aria-modal="true" aria-labelledby="allocation-dialog-title"><div class="modal-header"><div><p class="eyebrow">New funding source</p><h2 id="allocation-dialog-title">Add an allocation</h2><p>Name it for the grant, program, department, or public purpose it funds.</p></div><button class="modal-close" type="button" data-action="registry-close" aria-label="Close">×</button></div><form id="allocation-form"><div class="registry-form-body"><div class="form-grid"><div class="field-group"><label for="allocationName">Allocation name</label><input class="field" id="allocationName" name="name" maxlength="80" required placeholder="Healthcare Grant"></div><div class="field-group"><label for="allocationCategory">Type</label><select class="select" id="allocationCategory" name="category"><option>Restricted grant</option><option>Program allocation</option><option>Department budget</option><option>Public allocation</option><option>Payroll allocation</option><option>Other</option></select></div><div class="field-group full"><label for="allocationPurpose">Purpose</label><input class="field" id="allocationPurpose" name="purpose" maxlength="240" placeholder="Medical supplies and approved healthcare operations"></div><div class="field-group full"><label for="allocationRule">Spending restriction</label><input class="field" id="allocationRule" name="spendingRule" maxlength="240" placeholder="Healthcare suppliers only; invoice required"></div><div class="field-group full"><label for="allocationWallet">XRPL Testnet public address <span class="optional">optional</span></label><input class="field code-input" id="allocationWallet" name="walletAddress" maxlength="80" placeholder="r…"><p class="input-note">Paste a public address now, use the currently connected operator address, or connect a wallet after creating the allocation.</p></div></div>${state.wallet.account ? `<button class="inline-wallet-choice" type="button" data-action="use-connected-wallet"><span>${svg('wallet')}</span><span><strong>Use connected ${esc(state.wallet.name || 'XRPL wallet')}</strong><small>${esc(state.wallet.account)}</small></span></button>` : ''}</div><div class="modal-actions"><button class="button secondary" type="button" data-action="registry-close">Cancel</button><button class="button primary" type="submit">Create allocation</button></div></form></section></div>`;
  if (state.registryDialog === 'payee') return `<div class="modal-backdrop"><section class="modal registry-dialog" role="dialog" aria-modal="true" aria-labelledby="payee-dialog-title"><div class="modal-header"><div><p class="eyebrow">New payment recipient</p><h2 id="payee-dialog-title">Add a payee</h2><p>Register a supplier, employee, contractor, or other approved recipient.</p></div><button class="modal-close" type="button" data-action="registry-close" aria-label="Close">×</button></div><form id="payee-form"><div class="registry-form-body"><div class="form-grid"><div class="field-group"><label for="payeeName">Name</label><input class="field" id="payeeName" name="name" maxlength="100" required placeholder="MedTech Supplies"></div><div class="field-group"><label for="payeeType">Payee type</label><select class="select" id="payeeType" name="type"><option value="SUPPLIER">Supplier</option><option value="EMPLOYEE">Employee</option><option value="CONTRACTOR">Contractor</option><option value="OTHER">Other</option></select></div><div class="field-group full"><label for="payeeRole">Service, role, or payment purpose</label><input class="field" id="payeeRole" name="role" maxlength="120" placeholder="Medical equipment supplier"></div><div class="field-group full"><label for="payeeWallet">XRPL Testnet recipient address</label><input class="field code-input" id="payeeWallet" name="walletAddress" maxlength="80" required placeholder="r…"><p class="input-note">Alloc-X checks the XRPL address checksum and rejects duplicates. Identity and wallet ownership are not checked.</p></div></div></div><div class="modal-actions"><button class="button secondary" type="button" data-action="registry-close">Cancel</button><button class="button primary" type="submit">Register payee</button></div></form></section></div>`;
  return '';
}

function voicePanel() {
  if (state.voiceState === 'IDLE' && !state.voiceInstruction) return '';
  if (state.voiceState === 'LISTENING') return `<section class="voice-panel listening" aria-live="polite"><span class="voice-wave" aria-hidden="true"></span><div><strong>Listening for your instruction…</strong><p>Speak naturally. Recording continues across pauses until you press Stop.</p><p class="voice-live-transcript" id="voice-live-transcript" aria-live="polite">Listening…</p></div>${button('Stop recording', 'voice-toggle', 'secondary')}</section>`;
  if (state.voiceState === 'PROCESSING') return `<section class="voice-panel" aria-live="polite"><span class="loader"></span><div><strong>Preparing your voice instruction</strong><p>Alloc-X is creating a transcript for your review. Nothing has been sent for payment.</p></div></section>`;
  if (state.voiceState === 'ERROR') return `<section class="voice-panel error" role="alert"><span>${svg('alert')}</span><div><strong>Voice input needs attention</strong><p>${esc(state.voiceTranscript || 'Microphone access or speech recognition is unavailable. You can still type your instruction.')}</p></div>${button('Try again', 'voice-toggle', 'secondary')}</section>`;
  const instruction = state.voiceInstruction;
  if (!instruction) return '';
  return `<section class="voice-panel review" aria-live="polite"><span>${svg('mic')}</span><div class="voice-review"><span class="voice-overline">Voice transcript · review required</span><strong>${esc(instruction.transcript)}</strong><p>This transcript is recorded with your consent. Confirm it before Alloc-X can interpret it; confirmation still cannot sign or settle a payment.</p></div><div class="voice-actions">${button('Discard', 'voice-discard', 'secondary')}<button class="button primary" type="button" data-action="voice-confirm">Confirm instruction ${svg('arrow', 'nav-icon')}</button></div></section>`;
}

function payments() { const payments = state.data.payments; const active = state.data.capabilities.canSettle; return `<section class="page-heading"><div><p class="eyebrow">Payment operations</p><h1>Payments</h1><p>Each item is built from server-owned references, then bound to a signed Approval Layer outcome.</p></div>${button(`${svg('plus', 'nav-icon')} Create payment`, 'route-new-payment', 'primary')}</section><section class="card pad"><div class="card-heading"><div><h2>Payment queue</h2><p>${active ? 'Independent signing, ledger validation, and reconciliation are available.' : 'Settlement is intentionally unavailable in this local workspace.'}</p></div><span class="status neutral">${payments.length} recorded</span></div>${payments.length ? paymentTable(payments) : empty('receipt', 'No payment records', 'Create a payment to see its controls, receipt, and lifecycle timeline here.')}</section>`; }

function paymentTable(payments) { return `<div class="table-wrap"><table class="table"><thead><tr><th>Payment</th><th>Allocation</th><th>Amount</th><th>Security outcome</th><th>Lifecycle</th><th></th></tr></thead><tbody>${payments.map((payment) => `<tr><td><span class="main-cell">${esc(obligationName(payment.intent.sourceObligationId))}</span><span class="sub-cell">${esc(payment.paymentId)}</span></td><td>${esc(allocationName(payment.intent.allocationId))}</td><td class="amount">${money(payment.intent.amount)}</td><td>${status(payment.decision.decision.outcome)}</td><td><span class="status neutral">${esc(labelState(payment.state))}</span></td><td><button class="table-link" data-action="open-payment" data-payment-id="${esc(payment.paymentId)}">Open <span aria-hidden="true">→</span></button></td></tr>`).join('')}</tbody></table></div>`; }

function newPayment() { const refs = state.data.paymentReferences; const live = state.data.capabilities.canSettle; return `<section class="page-heading"><div><p class="eyebrow">Protected payment creation</p><h1>Prepare a payment</h1><p>Select the approved obligation and allocation. Amount, destination, asset, and evidence are resolved only by the server.</p></div>${button('Cancel', 'route-payments')}</section><div class="grid two" style="grid-template-columns:minmax(0,1.45fr) minmax(290px,.8fr)"><form class="card pad" id="payment-form"><div class="card-heading"><div><h2>Authoritative references</h2><p>Changing a selection never changes protected payment fields in the browser.</p></div><span class="status neutral">Draft</span></div><div class="form-grid"><div class="field-group full"><label for="obligationId">Obligation</label><select class="select" id="obligationId" name="obligationId">${refs.obligations.map((obligation) => `<option value="${esc(obligation.obligationId)}">${esc(obligation.displayName)} · ${money(obligation.amount)}</option>`).join('')}</select><p class="input-note">The obligation fixes purpose, due date, amount, asset, and evidence reference.</p></div><div class="field-group"><label for="allocationId">Allocation envelope</label><select class="select" id="allocationId" name="allocationId">${refs.allocations.map((allocation) => `<option value="${esc(allocation.allocationId)}">${esc(allocation.displayName)}</option>`).join('')}</select></div><div class="field-group"><label for="beneficiaryId">Approved beneficiary</label><select class="select" id="beneficiaryId" name="beneficiaryId">${refs.beneficiaries.map((beneficiary) => `<option value="${esc(beneficiary.beneficiaryId)}">${esc(beneficiary.label)}</option>`).join('')}</select></div><div class="field-group full"><label>Protected payment fields</label><div class="reference-preview" id="reference-preview"></div></div></div><div class="card-divider"></div><div class="row"><span class="small">Creating this record reserves available capacity and starts an independent security evaluation.</span><button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Creating…' : `Create and assess ${svg('arrow', 'nav-icon')}`}</button></div></form><aside class="card pad security-panel"><div class="card-heading"><div><h2>What happens next</h2><p>Payment state is not decided by this screen.</p></div></div><div class="control"><span class="control-icon">1</span><div><b>Canonical intent</b><span>Server resolves approved records and reserves capacity.</span></div></div><div class="control"><span class="control-icon">2</span><div><b>Approval Layer evaluation</b><span>Policy, evidence, beneficiary, and risk gates decide allow, review, or block.</span></div></div><div class="control"><span class="control-icon">3</span><div><b>Durable receipt</b><span>Decision and audit event are written before the result is released.</span></div></div><div class="control"><span class="control-icon">4</span><div><b>Independent settlement</b><span>${live ? 'Signer quorum, validated ledger execution, and independent reconciliation are active.' : 'Not available until the signer and ledger services are connected.'}</span></div></div></aside></div>`; }

function agentWorkspace() { const session = state.agentSession; const actions = session?.actions || []; const capability = state.data.agent; return `<section class="page-heading"><div><p class="eyebrow">Bounded autonomous allocation</p><h1>Allocation agent</h1><p>Give a precise instruction. The agent resolves approved records, explains policy, and creates a bounded draft. It cannot sign, submit, change policy, or access credentials.</p></div>${session ? status(session.state === 'DRAFTED' ? 'ALLOW' : session.state === 'AWAITING_EVIDENCE' ? 'REVIEW' : 'REVIEW', session.state.replaceAll('_', ' ')) : status('REVIEW', 'Ready')}</section><div class="grid two" style="grid-template-columns:minmax(0,1.35fr) minmax(300px,.85fr)"><section class="card pad"><div class="card-heading"><div><h2>Payment instruction</h2><p>Use the explicit command format below. Every tool action is stored as a tamper-evident trace.</p></div>${svg('agent', 'nav-icon')}</div><form id="agent-form"><div class="field-group"><label for="agentMessage">Instruction</label><input class="field" id="agentMessage" name="message" maxlength="500" required placeholder="pay 1350 XRP to MedTech Supplies for operations-supplies" value="${esc(session ? '' : 'pay 1350 XRP to MedTech Supplies for operations-supplies')}"><p class="input-note">${esc(capability.commandFormat)}</p></div><div class="card-divider"></div><div class="row"><span class="small">A draft is not a payment. The protected payment workflow and Approval Layer still decide whether it can proceed.</span><button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Working…' : `Ask agent ${svg('arrow', 'nav-icon')}`}</button></div></form>${actions.length ? `<div class="card-divider"></div><div class="card-heading"><div><h2>Action trace</h2><p>Server-authorized tools only</p></div><span class="status neutral">${actions.length} steps</span></div><div class="timeline">${actions.map((action) => `<div class="event ${action.name === 'payment.draft' ? 'allowed' : action.name === 'evidence.request' ? 'review' : ''}"><div class="event-title">${esc(action.name.replaceAll('.', ' · '))}</div><div class="event-copy">${esc(action.detail)}</div><div class="event-time">${when(action.occurredAt)} · input ${esc(compact(action.inputDigest))}</div></div>`).join('')}</div>` : empty('agent', 'No agent actions yet', 'Submit a precise instruction to create a durable, server-authorized tool trace.')}</section><aside class="card pad security-panel"><div class="card-heading"><div><h2>Agent safety boundary</h2><p>Authority stays outside the language interface.</p></div></div><div class="control"><span class="control-icon">1</span><div><b>Typed tools only</b><span>Beneficiary resolution, evidence request, policy explanation, and bounded drafts.</span></div></div><div class="control"><span class="control-icon">2</span><div><b>No signing access</b><span>Keys, signer quorum, and ledger submission remain separate.</span></div></div><div class="control"><span class="control-icon">3</span><div><b>No control bypass</b><span>It cannot publish policy, access the database, or call arbitrary network services.</span></div></div><div class="control"><span class="control-icon">4</span><div><b>Protected execution later</b><span>Any eligible draft still passes the normal Approval Layer and independent settlement path.</span></div></div></aside></div>`; }

function cashRunway() { return `<section class="page-heading"><div><p class="eyebrow">Advisory cash planning</p><h1>Cash runway</h1><p>Forecasts will be calculated only from a connected treasury and recorded inflows, obligations, reserves, and payroll rules.</p></div>${status('REVIEW', 'Configuration required')}</section><div class="banner wallet-banner attention">${svg('shield')}<div><strong>No estimated money values are displayed</strong>Connect the Testnet treasury and configure authoritative planning inputs before Alloc-X generates a runway.</div>${state.wallet.status === 'CONNECTED' ? '' : button('Connect wallet', 'wallet-connect', 'primary')}</div><section class="card pad">${empty('funds', 'Planning inputs are not configured', 'Add verified inflows, obligations and protection rules to generate a traceable forecast from the live Testnet balance.')}</section>`; }

function paymentPlan() { return `<section class="page-heading"><div><p class="eyebrow">Safe scheduling recommendations</p><h1>Payment plan</h1><p>Scheduling activates only when verified obligations and allocation rules are recorded against the connected treasury.</p></div>${status('REVIEW', 'Configuration required')}</section><div class="banner wallet-banner attention">${svg('shield')}<div><strong>No fabricated schedule or fee estimate</strong>Alloc-X will calculate recommendations from current Testnet balance, recorded obligations and live network fees.</div>${state.wallet.status === 'CONNECTED' ? '' : button('Connect wallet', 'wallet-connect', 'primary')}</div><section class="card pad">${empty('clock', 'No authoritative payment schedule', 'Record real obligations and allocation rules before generating a payment plan.')}</section>`; }

function beneficiaryWorkspace() {
  const payees = state.registry.payees;
  const suppliers = payees.filter((payee) => payee.type === 'SUPPLIER').length;
  const employees = payees.filter((payee) => payee.type === 'EMPLOYEE').length;
  return `<section class="page-heading"><div><p class="eyebrow">Recipient management</p><h1>Payees</h1><p>Register every supplier, employee, contractor, or other recipient your organization is permitted to pay. Add or remove entries whenever your operating relationships change.</p></div>${button(`${svg('plus', 'nav-icon')} Add payee`, 'add-payee', 'primary')}</section>
    <div class="grid three registry-metrics"><article class="card pad metric"><div class="metric-top"><span class="metric-label">All payees</span><span class="metric-icon">${svg('users')}</span></div><div class="metric-value">${payees.length}</div><span class="metric-sub">No fixed limit</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Suppliers</span><span class="metric-icon">${svg('funds')}</span></div><div class="metric-value">${suppliers}</div><span class="metric-sub">Goods and services</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Employees</span><span class="metric-icon">${svg('users')}</span></div><div class="metric-value">${employees}</div><span class="metric-sub">Payroll recipients</span></article></div>
    <div class="banner registry-banner">${svg('shield')}<div><strong>Recipient addresses stay separate from funding wallets</strong>Payee registration checks the XRPL address checksum and prevents duplicate recipients. It does not verify identity or wallet ownership. Alloc-X never stores private keys.</div></div>
    <section class="card pad"><div class="card-heading"><div><h2>Payee directory</h2><p>Two registration checks: valid XRPL address and no duplicate payee or wallet. No approval step.</p></div><span class="status neutral">${payees.length} registered</span></div>${payees.length ? `<div class="table-wrap"><table class="table payee-table"><thead><tr><th>Payee</th><th>Type</th><th>Role or service</th><th>XRPL address</th><th>Status</th><th></th></tr></thead><tbody>${payees.map((payee) => `<tr><td><span class="main-cell">${esc(payee.name)}</span></td><td><span class="payee-type ${payee.type.toLowerCase()}">${esc(payee.type.toLowerCase())}</span></td><td>${esc(payee.role || 'Not specified')}</td><td><span class="sub-cell address-cell">${esc(payee.walletAddress)}</span></td><td>${payee.status === 'ADDRESS_CHECKED' ? status('ALLOW', 'Address checked') : status('REVIEW', payee.status === 'INVALID_ADDRESS' ? 'Invalid address' : 'Check unavailable')}</td><td><button class="icon-button danger-icon" type="button" data-action="remove-payee" data-payee-id="${esc(payee.payeeId)}" aria-label="Remove ${esc(payee.name)}">${svg('trash')}</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="registry-empty">${empty('users', 'No payees registered', 'Add the supplier, employee, contractor, or other recipient you want Alloc-X to recognize.')}<button class="button primary" type="button" data-action="add-payee">${svg('plus', 'nav-icon')} Add first payee</button></div>`}</section>`;
}

function beneficiaryDetail() { const record = state.data.beneficiaries.find((item) => item.beneficiary.beneficiaryId === state.activeBeneficiaryId); if (!record) { state.route = 'beneficiaries'; return beneficiaryWorkspace(); } const activeChange = record.changes.find((change) => !['active', 'rejected', 'cancelled'].includes(change.status)); return `<section class="page-heading"><div><p class="eyebrow">Beneficiary record</p><h1>${esc(beneficiaryName(record.beneficiary.beneficiaryId))}</h1><p>Verified ownership, immutable wallet history, and controlled destination changes.</p></div>${button('Back to beneficiaries', 'route-beneficiaries')}</section><div class="detail-grid"><section class="card pad"><div class="card-heading"><div><h2>Wallet history</h2><p>Versions are never overwritten.</p></div>${status(record.beneficiary.status === 'approved' ? 'ALLOW' : 'REVIEW', record.beneficiary.status)}</div><div class="timeline">${record.walletHistory.map((version) => `<div class="event ${version.version === record.beneficiary.walletVersion ? 'allowed' : ''}"><div class="event-title">Wallet version ${version.version}</div><div class="event-copy code">${esc(version.wallet.address)}${version.wallet.destinationTag === undefined ? '' : ` · tag ${version.wallet.destinationTag}`}</div><div class="event-time">${version.activatedAt ? `Activated ${when(version.activatedAt)}` : `Registered ${when(version.createdAt)}`}</div></div>`).join('')}</div></section><aside class="grid"><section class="card pad"><div class="card-heading"><div><h2>Ownership evidence</h2><p>Required before approval</p></div></div><div class="receipt-key">Verification method</div><div class="receipt-value">${esc(record.ownership.method)}</div><div class="receipt-key">Verification state</div><div class="receipt-value">${record.ownership.status === 'verified' ? status('ALLOW', 'Verified') : status('REVIEW', record.ownership.status)}</div><div class="receipt-key">Evidence hash</div><div class="receipt-value code">${esc(record.ownership.evidenceHash)}</div></section><section class="card pad"><div class="card-heading"><div><h2>Change control</h2><p>Independent workflow</p></div></div>${activeChange ? `<div class="receipt-key">Active request</div><div class="receipt-value">${esc(activeChange.status)}</div><div class="receipt-key">Requested destination</div><div class="receipt-value code">${esc(activeChange.requestedWallet.address)}</div>` : `<div class="empty">${svg('check')}<strong>No active destination change</strong><p>The current wallet version is approved for controlled use.</p></div>`}</section></aside></div>`; }

function security() { const payments = state.data.payments; const latest = payments[0]; return `<section class="page-heading"><div><p class="eyebrow">Security operations</p><h1>Approval Layer controls</h1><p>Every payment evaluation is authenticated, deterministic, signed, audited, and durably recorded before an outcome is returned.</p></div>${button(`${svg('refresh', 'nav-icon')} Verify journal`, 'reload')}</section><div class="grid two"><section class="card pad security-panel"><div class="card-heading"><div><h2>Security posture</h2><p>Control status from the active local service.</p></div>${status(state.data.securityJournal.valid ? 'ALLOW' : 'DENY', state.data.securityJournal.valid ? 'Verified' : 'Attention')}</div><div class="control"><span class="control-icon">${svg('shield')}</span><div><b>Service identity</b><span>Dedicated Approval Layer service identity is authenticated for every evaluation.</span></div></div><div class="control"><span class="control-icon">${svg('lock')}</span><div><b>Decision binding</b><span>Signed decision covers organization, intent digest, key, and expiry.</span></div></div><div class="control"><span class="control-icon">${svg('audit')}</span><div><b>Recovery journal</b><span>${state.data.securityJournal.checkedRecords} durable records · ${state.data.securityJournal.valid ? 'hash chain valid' : 'integrity failure detected'}</span></div></div></section><section class="card pad"><div class="card-heading"><div><h2>Settlement boundary</h2><p>Enforced separation of controls.</p></div><span class="status neutral">Not connected</span></div><div class="timeline"><div class="event allowed"><div class="event-title">Create and assess is available</div><div class="event-copy">Alloc-X can construct a canonical intent and record a signed security decision.</div></div><div class="event"><div class="event-title">Independent signer required</div><div class="event-copy">No private key or direct signing capability is exposed to this console.</div></div><div class="event"><div class="event-title">XRPL adapter required</div><div class="event-copy">Settlement cannot begin until the ledger adapter, signer quorum, and reconciliation are implemented.</div></div></div></section></div>${latest ? `<section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Latest recorded decision</h2><p>Decision trace is evidence, not a claim that settlement occurred.</p></div>${status(latest.decision.decision.outcome)}</div>${decisionTrace(latest)}</section>` : ''}`; }

function securityConsole() {
  const { securityControls: controls, signerHealth, policyVersions, beneficiaryEvents, payments } = state.data;
  const activeFreezes = controls.freezes.filter((item) => item.status === 'ACTIVE');
  const pendingChanges = controls.limitChanges.filter((item) => item.status !== 'READY_FOR_POLICY_PUBLICATION');
  const latest = payments[0];
  return `<section class="page-heading"><div><p class="eyebrow">Security operations</p><h1>Approval Layer security console</h1><p>Live controls sit before payment creation. Every decision keeps its deterministic trace, signed receipt, and recovery record.</p></div>${button(`${svg('refresh', 'nav-icon')} Refresh controls`, 'reload')}</section>
  ${activeFreezes.length ? `<div class="banner security-alert">${svg('alert')}<div><strong>Emergency control active</strong>${activeFreezes.length} active freeze${activeFreezes.length === 1 ? '' : 's'} is stopping matching payments before an intent can be created.</div></div>` : ''}
  <div class="grid four"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Decision journal</span><span class="metric-icon">${svg('audit')}</span></div><div class="metric-value">${state.data.securityJournal.checkedRecords}</div><span class="metric-sub ${state.data.securityJournal.valid ? 'positive' : ''}">${state.data.securityJournal.valid ? 'Integrity verified' : 'Needs attention'}</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Emergency freezes</span><span class="metric-icon">${svg('lock')}</span></div><div class="metric-value">${activeFreezes.length}</div><span class="metric-sub">${activeFreezes.length ? 'Payment creation restricted' : 'No active restriction'}</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Control changes</span><span class="metric-icon">${svg('shield')}</span></div><div class="metric-value">${pendingChanges.length}</div><span class="metric-sub">Awaiting independent checks</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Signer health</span><span class="metric-icon">${svg('wallet')}</span></div><div class="metric-value small">${esc(signerHealth.status)}</div><span class="metric-sub">${esc(signerHealth.quorum)}</span></article></div>
  <div class="grid two" style="margin-top:18px"><section class="card pad security-panel"><div class="card-heading"><div><h2>Security posture</h2><p>Live boundaries protecting treasury execution.</p></div>${status(state.data.securityJournal.valid ? 'ALLOW' : 'DENY', state.data.securityJournal.valid ? 'Verified' : 'Attention')}</div><div class="control"><span class="control-icon">${svg('shield')}</span><div><b>Authenticated decision service</b><span>Every evaluation requires the dedicated server-side service assertion.</span></div></div><div class="control"><span class="control-icon">${svg('lock')}</span><div><b>Pre-intent control gate</b><span>An active freeze blocks a payment before capacity can be reserved.</span></div></div><div class="control"><span class="control-icon">${svg('audit')}</span><div><b>Durable recovery</b><span>${state.data.securityJournal.checkedRecords} signed decisions are hash-chain checked.</span></div></div></section><section class="card pad"><div class="card-heading"><div><h2>Settlement signer health</h2><p>Signing remains separated from this console.</p></div>${status(signerHealth.status === 'HEALTHY' ? 'ALLOW' : 'REVIEW', signerHealth.status)}</div><div class="receipt-key">Quorum</div><div class="receipt-value">${esc(signerHealth.quorum)}</div><div class="receipt-key">Status detail</div><div class="receipt-value">${esc(signerHealth.detail)}</div><div class="card-divider"></div><p class="small">The console does not hold a signing key or a direct ledger submission capability.</p></section></div>
  <div class="grid two" style="margin-top:18px"><section class="card pad"><div class="card-heading"><div><h2>Emergency freeze</h2><p>Immediate stop control. An independent approver is required to release it.</p></div>${status(activeFreezes.length ? 'DENY' : 'ALLOW', activeFreezes.length ? 'Active' : 'Ready')}</div><form id="emergency-freeze-form"><div class="form-grid"><div class="field-group"><label for="freezeScope">Scope</label><select class="select" id="freezeScope" name="scope"><option value="organization">Entire organization</option><option value="asset">XRP payments</option><option value="beneficiary">MedTech Supplies</option></select></div><div class="field-group"><label for="freezeReason">Reason</label><input class="field" id="freezeReason" name="reason" minlength="5" maxlength="500" required placeholder="Describe the observed risk"></div></div><div class="card-divider"></div><div class="row"><span class="small">This action is written to the security control record.</span><button class="button danger" type="submit">Apply emergency freeze</button></div></form>${activeFreezes.length ? `<div class="control-list">${activeFreezes.map((freeze) => `<div class="control-change"><div><b>${esc(scopeLabel(freeze.scope))}</b><span>${esc(freeze.reason)} · ${when(freeze.frozenAt)}</span></div>${button('Release', 'release-freeze', 'secondary', `data-freeze-id="${esc(freeze.freezeId)}"`)}</div>`).join('')}</div>` : ''}</section><section class="card pad"><div class="card-heading"><div><h2>Safely scoped limit change</h2><p>Changes never alter execution directly; approved items move into policy publication.</p></div></div><form id="limit-change-form"><div class="form-grid"><div class="field-group"><label for="limitControl">Control</label><select class="select" id="limitControl" name="control"><option value="max-payment-amount">Maximum payment amount</option><option value="reserve-floor">Minimum reserve floor</option><option value="daily-payment-count">Daily payment count</option><option value="daily-payment-amount">Daily payment amount</option></select></div><div class="field-group"><label for="requestedValue">Requested value</label><input class="field" id="requestedValue" name="requestedValue" inputmode="decimal" required placeholder="e.g. 4500"></div><div class="field-group full"><label for="limitJustification">Justification</label><input class="field" id="limitJustification" name="justification" minlength="10" maxlength="1000" required placeholder="Why this change is needed"></div></div><div class="card-divider"></div><div class="row"><span class="small">Relaxing a control needs requester, approver, and independent escalation.</span><button class="button secondary" type="submit">Request change</button></div></form></section></div>
  <section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Control-change workflow</h2><p>Approval is stronger for a relaxation than it is for applying a freeze.</p></div></div>${controls.limitChanges.length ? `<div class="control-list">${controls.limitChanges.map(limitChangeRow).join('')}</div>` : empty('shield', 'No limit-change requests', 'New requests stay separate from the active policy until the required independent approvals are complete.')}</section>
  <div class="grid two" style="margin-top:18px"><section class="card pad"><div class="card-heading"><div><h2>Published policy versions</h2><p>Policy changes are versioned and published through a separate workflow.</p></div></div>${policyVersions.map((policy) => `<div class="allocation-item"><div><div class="allocation-name">${esc(policy.policyVersion)}</div><div class="allocation-meta">${esc(policy.summary)} · effective ${when(policy.effectiveFrom)}</div></div>${status('ALLOW', policy.status)}</div>`).join('')}</section><section class="card pad"><div class="card-heading"><div><h2>Beneficiary security events</h2><p>Destination lifecycle events from the beneficiary registry.</p></div></div>${beneficiaryEvents.length ? `<div class="timeline">${beneficiaryEvents.slice().reverse().slice(0, 4).map((item) => `<div class="event allowed"><div class="event-title">${esc(item.type.replaceAll('-', ' '))}</div><div class="event-copy">${esc(beneficiaryName(item.beneficiaryId))}</div><div class="event-time">${when(item.occurredAt)}</div></div>`).join('')}</div>` : empty('users', 'No beneficiary events', 'Verified beneficiary activity will appear here.')}</section></div>
  <section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Decision trace and reason codes</h2><p>Operators can open any payment to inspect the complete deterministic evidence.</p></div>${latest ? status(latest.decision.decision.outcome) : ''}</div>${latest ? decisionTrace(latest) : empty('receipt', 'No recorded decisions', 'Create a protected payment assessment to see the signed decision trace and reason codes.')}</section>`;
}

function scopeLabel(scope) { return scope.kind === 'organization' ? 'Organization-wide freeze' : scope.kind === 'asset' ? `${scope.asset} payment freeze` : `${beneficiaryName(scope.beneficiaryId)} freeze`; }
function currentLimit(control) { return ({ 'max-payment-amount': '5000', 'reserve-floor': '1000', 'daily-payment-count': '10', 'daily-payment-amount': '10000' })[control]; }
function limitChangeRow(change) { const nextAction = change.status === 'PENDING' ? button('Approve', 'approve-limit-change', 'secondary', `data-change-id="${esc(change.changeId)}"`) : change.status === 'AWAITING_ESCALATION' ? button('Escalate', 'escalate-limit-change', 'secondary', `data-change-id="${esc(change.changeId)}"`) : ''; return `<div class="control-change"><div><b>${esc(change.control.replaceAll('-', ' '))} · ${esc(change.currentValue)} → ${esc(change.requestedValue)}</b><span>${esc(change.effect)} · ${esc(change.status.replaceAll('_', ' '))} · ${esc(change.justification)}</span></div><div class="row">${status(change.effect === 'RELAX' ? 'REVIEW' : 'ALLOW', change.effect)}${nextAction}</div></div>`; }

function operations() { const operations = state.data.operations; const latest = new Map(); operations.metrics.forEach((metric) => latest.set(metric.name, metric)); return `<section class="page-heading"><div><p class="eyebrow">Operational assurance</p><h1>Operations</h1><p>Live service, queue, payment, signer, reconciliation, policy, ledger, and agent-cost signals.</p></div>${status(operations.health === 'HEALTHY' ? 'ALLOW' : operations.health === 'CRITICAL' ? 'DENY' : 'REVIEW', operations.health)}</section><div class="grid four">${['service.health','queue.depth','payment.latency_ms','veto.rate_percent','signer.failures','reconciliation.lag_seconds','unknown_outflows','policy.errors'].map((name) => { const metric = latest.get(name); return `<article class="card pad metric"><div class="metric-top"><span class="metric-label">${esc(name.replaceAll('.', ' '))}</span><span class="metric-icon">${svg(name.includes('signer') || name.includes('outflow') ? 'alert' : 'audit')}</span></div><div class="metric-value">${metric ? Number(metric.value).toLocaleString(undefined,{maximumFractionDigits:2}) : '—'}</div><span class="metric-sub">${esc(metric?.service || 'No observation')}</span></article>`; }).join('')}</div><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Actionable alerts</h2><p>Every alert has an accountable owner and operational runbook.</p></div><span class="status neutral">${operations.alerts.length} open</span></div>${operations.alerts.length ? `<div class="control-list">${operations.alerts.map((alert) => `<div class="control-change"><div><b>${esc(alert.metric)} · ${esc(alert.severity)}</b><span>${esc(alert.owner)} · observed ${esc(alert.observedValue)} · threshold ${esc(alert.threshold)}</span><span class="code">${esc(alert.runbook)}</span></div>${status(alert.severity === 'critical' ? 'DENY' : 'REVIEW', 'OPEN')}</div>`).join('')}</div>` : empty('check','No operational alerts','All recorded signals are inside their configured thresholds.')}</section><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Privacy-safe trace policy</h2><p>Operational traces exclude secrets, signing material, destinations, and raw evidence.</p></div><span class="status neutral">${operations.traces.length} traces</span></div><p class="small">Telemetry accepts only bounded attributes such as organization identifier, service, outcome, and duration. Forbidden fields are rejected before recording.</p></section>`; }

function offlineTrust() { const trust = state.data.offlineTrust; const workflows = state.data.offlineWorkflows; return `<section class="page-heading"><div><p class="eyebrow">Device-bound continuity</p><h1>Offline trust</h1><p>Encrypted preparation can continue during connectivity loss without carrying treasury signing authority.</p></div>${status(trust.status === 'ACTIVE' ? 'ALLOW' : 'REVIEW', trust.status.replaceAll('_', ' '))}</section><div class="grid four"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Device status</span><span class="metric-icon">${svg('wallet')}</span></div><div class="metric-value">${esc(trust.status.replaceAll('_', ' '))}</div><span class="metric-sub">${esc(trust.deviceId || 'No enrolled device')}</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Connectivity</span><span class="metric-icon">${svg('refresh')}</span></div><div class="metric-value">${esc(workflows.connectivity)}</div><span class="metric-sub">Explicit connection state</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Prepared offline</span><span class="metric-icon">${svg('audit')}</span></div><div class="metric-value">${esc(workflows.preparedPayments)}</div><span class="metric-sub">Unsubmitted work only</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Synchronization</span><span class="metric-icon">${svg('shield')}</span></div><div class="metric-value">${trust.synchronizationAllowed ? 'READY' : 'BLOCKED'}</div><span class="metric-sub">Fresh server trust is required</span></article></div><div class="banner ${trust.status === 'ACTIVE' ? '' : 'security-alert'}" style="margin-top:18px">${svg('shield')}<div><strong>${trust.status === 'ACTIVE' ? 'Device trust is active' : 'Offline vault is unavailable on this device'}</strong>${esc(workflows.detail)}</div></div><div class="grid two"><section class="card pad"><div class="card-heading"><div><h2>Offline work that can be captured</h2><p>Available only after device enrollment.</p></div>${status(workflows.capability === 'READY' ? 'ALLOW' : 'REVIEW', workflows.capability.replaceAll('_', ' '))}</div><div class="control-list"><div class="control-change"><div><b>Cached read views</b><span>Versioned reference data is clearly marked current or expired.</span></div>${status('ALLOW', 'PREPARE')}</div><div class="control-change"><div><b>Obligation and evidence capture</b><span>Field work can be recorded in the encrypted journal.</span></div>${status('ALLOW', 'PREPARE')}</div><div class="control-change"><div><b>Allocation draft and payment preparation</b><span>Every prepared instruction remains unsubmitted and needs reconnection.</span></div>${status('REVIEW', 'REVALIDATE')}</div></div></section><aside class="card pad security-panel"><div class="card-heading"><div><h2>Never available offline</h2><p>Preparation is not settlement.</p></div></div><div class="control"><span class="control-icon">1</span><div><b>No treasury signing keys</b><span>The vault rejects signing material and credentials.</span></div></div><div class="control"><span class="control-icon">2</span><div><b>No Approval Layer decision</b><span>Offline work must receive a fresh online security evaluation.</span></div></div><div class="control"><span class="control-icon">3</span><div><b>No ledger submission</b><span>The device cannot sign, submit, validate, reconcile, or represent settlement.</span></div></div><div class="control"><span class="control-icon">4</span><div><b>Cryptographic wipe</b><span>Key destruction makes remaining ciphertext unreadable before file removal.</span></div></div></aside></div>`; }

function offlineSync() { const sync = state.data.offlineSynchronization; return `<section class="page-heading"><div><p class="eyebrow">Safe reconnection</p><h1>Offline synchronization</h1><p>Disconnected work is server-ordered, deduplicated, and checked against current authoritative records.</p></div>${status(sync.status === 'READY' ? 'ALLOW' : 'REVIEW', sync.status.replaceAll('_', ' '))}</section><div class="grid three"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Server-ordered work</span><span class="metric-icon">${svg('audit')}</span></div><div class="metric-value">${esc(sync.serverOrderedOperations)}</div><span class="metric-sub">Accepted only after device trust</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Open conflicts</span><span class="metric-icon">${svg('alert')}</span></div><div class="metric-value">${esc(sync.openConflicts)}</div><span class="metric-sub">Human resolution is required</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Retry protection</span><span class="metric-icon">${svg('shield')}</span></div><div class="metric-value">ACTIVE</div><span class="metric-sub">Exact retries never duplicate work</span></article></div><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Reconnect boundary</h2><p>${esc(sync.detail)}</p></div></div><div class="control-list"><div class="control-change"><div><b>Automatic duplicate suppression</b><span>Only an identical signed operation can be recognized as a retry.</span></div>${status('ALLOW', 'ENFORCED')}</div><div class="control-change"><div><b>Explicit conflict resolution</b><span>Amount, destination, policy, allocation, and approval conflicts can only be discarded or reprepared online.</span></div>${status('REVIEW', 'REQUIRED')}</div><div class="control-change"><div><b>Fresh online revalidation</b><span>Synchronized payment preparation is never approved, signed, submitted, or settled here.</span></div>${status('DENY', 'NOT EXECUTABLE')}</div></div></section>`; }

function offlineRevalidation() { const gate = state.data.offlineRevalidation; return `<section class="page-heading"><div><p class="eyebrow">Signing boundary</p><h1>Online revalidation</h1><p>Every offline-prepared instruction must be re-established from live, authoritative information before signing.</p></div>${status('REVIEW', gate.status.replaceAll('_', ' '))}</section><div class="grid two"><section class="card pad"><div class="card-heading"><div><h2>Required fresh checks</h2><p>${esc(gate.detail)}</p></div></div><div class="control-list"><div class="control-change"><div><b>Identity and intent</b><span>Step-up authentication and the exact newly created payment-intent digest are required.</span></div>${status('ALLOW', 'REQUIRED')}</div><div class="control-change"><div><b>Policy, beneficiary, and destination</b><span>Current approved records must exactly match the prepared instruction.</span></div>${status('ALLOW', 'REQUIRED')}</div><div class="control-change"><div><b>Balances, risk, and ledger</b><span>Live treasury state, risk signals, and ledger reachability are mandatory.</span></div>${status('ALLOW', 'REQUIRED')}</div><div class="control-change"><div><b>New Approval Layer decision</b><span>A fresh signed allow decision must verify against this intent.</span></div>${status('ALLOW', 'REQUIRED')}</div></div></section><aside class="card pad security-panel"><div class="card-heading"><div><h2>Signing eligibility</h2><p>Current local workspace status</p></div></div><div class="metric-value">${esc(gate.signingEligible)}</div><span class="metric-sub">offline-prepared payments eligible to approach signing</span><div class="card-divider"></div><div class="control"><span class="control-icon">1</span><div><b>Review and denial stop here</b><span>Only a verified fresh allow result can reach the independent signing path.</span></div></div><div class="control"><span class="control-icon">2</span><div><b>Offline approval cannot pass</b><span>Cached results, signatures, and records have no authority at this gate.</span></div></div></aside></div>`; }

function organizationCapabilities() { const profile = state.data.organizationCapabilities; return `<section class="page-heading"><div><p class="eyebrow">Organization expansion</p><h1>Organization model</h1><p>One protected payment core, configured for the operating model and reporting needs of each organization.</p></div>${status('REVIEW', profile.status.replaceAll('_', ' '))}</section><div class="grid three"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Organization type</span><span class="metric-icon">${svg('users')}</span></div><div class="metric-value">${esc(profile.organizationType)}</div><span class="metric-sub">Configurable per tenant</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Policy pack</span><span class="metric-icon">${svg('shield')}</span></div><div class="metric-value">${esc(profile.policyPack)}</div><span class="metric-sub">Versioned organization rules</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Core controls</span><span class="metric-icon">${svg('lock')}</span></div><div class="metric-value">SHARED</div><span class="metric-sub">No organization-specific signing path</span></article></div><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Governed configuration</h2><p>${esc(profile.detail)}</p></div></div><div class="control-list"><div class="control-change"><div><b>Accounts and allocations</b><span>Chart-of-accounts mappings classify the organization’s spending without changing capacity controls.</span></div>${status('ALLOW', 'CONFIGURED')}</div><div class="control-change"><div><b>Approval responsibilities</b><span>Approval matrices define roles and separation requirements outside the allocation agent.</span></div>${status('ALLOW', 'GOVERNED')}</div><div class="control-change"><div><b>Reports and integrations</b><span>Declared templates and integration contracts keep data handling explicit and reviewable.</span></div>${status('ALLOW', 'DECLARED')}</div><div class="control-change"><div><b>Independent activation</b><span>An administrator drafts the model; a different reviewer must activate it.</span></div>${status('REVIEW', 'REQUIRED')}</div></div></section>`; }

function commercialControls() { const commercial = state.data.commercialPolicyPack; return `<section class="page-heading"><div><p class="eyebrow">Commercial policy pack</p><h1>Commercial controls</h1><p>Department budgets, procurement discipline, payroll protection, and vendor controls—before the shared security flow.</p></div>${status('REVIEW', commercial.status.replaceAll('_', ' '))}</section><div class="grid three"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Department budgets</span><span class="metric-icon">${svg('funds')}</span></div><div class="metric-value">${esc(commercial.departmentBudgets)}</div><span class="metric-sub">Configured departments</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Vendor control</span><span class="metric-icon">${svg('users')}</span></div><div class="metric-value">GOVERNED</div><span class="metric-sub">Approved vendors and status checks</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Settlement authority</span><span class="metric-icon">${svg('lock')}</span></div><div class="metric-value">NONE</div><span class="metric-sub">This pack cannot sign or submit</span></article></div><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Commercial assessment boundary</h2><p>${esc(commercial.detail)}</p></div></div><div class="control-list"><div class="control-change"><div><b>Department capacity</b><span>Authorized, committed, and spent amounts are evaluated with fixed precision.</span></div>${status('ALLOW', 'CHECKED')}</div><div class="control-change"><div><b>Payroll protection</b><span>Only designated payroll vendors can receive payroll payments.</span></div>${status('ALLOW', 'ENFORCED')}</div><div class="control-change"><div><b>Purchase-order matching</b><span>Missing or uncertain evidence becomes review; mismatched or unsafe work is denied.</span></div>${status('REVIEW', 'CONTROLLED')}</div><div class="control-change"><div><b>Shared final gate</b><span>Every outcome still needs the normal Approval Layer, signer, and ledger path.</span></div>${status('DENY', 'NO BYPASS')}</div></div></section>`; }

function nonprofitControls() { const nonprofit = state.data.nonprofitPolicyPack; return `<section class="page-heading"><div><p class="eyebrow">Nonprofit policy pack</p><h1>Program controls</h1><p>Program allocations and donor mandates are evaluated before the shared Approval Layer and settlement flow.</p></div>${status('REVIEW', nonprofit.status.replaceAll('_', ' '))}</section><div class="grid three"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Program allocations</span><span class="metric-icon">${svg('funds')}</span></div><div class="metric-value">${esc(nonprofit.programAllocations)}</div><span class="metric-sub">Configured program envelopes</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Donor mandates</span><span class="metric-icon">${svg('audit')}</span></div><div class="metric-value">GOVERNED</div><span class="metric-sub">Purpose and evidence boundaries</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Settlement authority</span><span class="metric-icon">${svg('lock')}</span></div><div class="metric-value">NONE</div><span class="metric-sub">This pack cannot sign or submit</span></article></div><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Program assessment boundary</h2><p>${esc(nonprofit.detail)}</p></div></div><div class="control-list"><div class="control-change"><div><b>Program capacity</b><span>Authorized, committed, and spent program balances are checked with fixed precision.</span></div>${status('ALLOW', 'CHECKED')}</div><div class="control-change"><div><b>Donor mandate fit</b><span>Program, cost category, evidence requirements, and mandate status must match.</span></div>${status('ALLOW', 'ENFORCED')}</div><div class="control-change"><div><b>Expiry and reporting</b><span>Expired allocations are denied; report periods remain visible and traceable.</span></div>${status('REVIEW', 'CONTROLLED')}</div><div class="control-change"><div><b>Shared final gate</b><span>A compliant program request still needs the normal security, signing, and ledger path.</span></div>${status('DENY', 'NO BYPASS')}</div></div></section>`; }

function publicSectorControls() { const publicSector = state.data.publicSectorPolicyPack; return `<section class="page-heading"><div><p class="eyebrow">Public-sector policy pack</p><h1>Public controls</h1><p>Appropriation, warrant, commitment, procurement, and accountability controls before the shared security flow.</p></div>${status('REVIEW', publicSector.status.replaceAll('_', ' '))}</section><div class="grid three"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Appropriations</span><span class="metric-icon">${svg('funds')}</span></div><div class="metric-value">${esc(publicSector.appropriations)}</div><span class="metric-sub">Configured spending authorities</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Approval levels</span><span class="metric-icon">${svg('users')}</span></div><div class="metric-value">GOVERNED</div><span class="metric-sub">Multi-level responsibility checks</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Jurisdiction claims</span><span class="metric-icon">${svg('shield')}</span></div><div class="metric-value">OFF</div><span class="metric-sub">Disabled until independently reviewed</span></article></div><section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Public expenditure boundary</h2><p>${esc(publicSector.detail)}</p></div></div><div class="control-list"><div class="control-change"><div><b>Appropriation and warrant</b><span>Current spending authority, account code, amount, and expiry must match.</span></div>${status('ALLOW', 'CHECKED')}</div><div class="control-change"><div><b>Commitment and procurement</b><span>Procurement evidence and the beneficiary commitment are checked before security evaluation.</span></div>${status('ALLOW', 'ENFORCED')}</div><div class="control-change"><div><b>Audit export</b><span>A minimal digest-bound accountability record is prepared for permitted export.</span></div>${status('REVIEW', 'TRACEABLE')}</div><div class="control-change"><div><b>Jurisdiction extensions</b><span>Specific compliance claims remain inactive until reviewed and explicitly enabled.</span></div>${status('DENY', 'INACTIVE')}</div></div></section>`; }

function mainnetReadiness() { const activation = state.data.mainnetActivation; const blockerLabels = { PRODUCTION_CONFIGURATION_MISSING: 'Production account and rollout configuration', INDEPENDENT_ASSESSMENT_INCOMPLETE: 'Independent security assessment sign-off', OPERATIONAL_MONITORING_UNHEALTHY: 'Healthy production monitoring', RECOVERY_EXERCISE_INCOMPLETE: 'Passing production recovery exercise', MAINNET_SIGNER_LIST_UNCONFIRMED: 'Confirmed on-ledger signer list' }; return `<section class="page-heading"><div><p class="eyebrow">Production settlement assurance</p><h1>Mainnet readiness</h1><p>Autonomous settlement remains fail-closed until every independent production control is verified.</p></div>${status(activation.allowed ? 'ALLOW' : 'DENY', activation.phase)}</section><div class="grid four"><article class="card pad metric"><div class="metric-top"><span class="metric-label">Activation phase</span><span class="metric-icon">${svg('lock')}</span></div><div class="metric-value">${esc(activation.phase)}</div><span class="metric-sub">${activation.allowed ? 'All readiness gates passed' : 'Settlement remains blocked'}</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Configuration approvals</span><span class="metric-icon">${svg('shield')}</span></div><div class="metric-value">${esc(activation.configurationApprovals)}<span class="small"> / 2</span></div><span class="metric-sub">Security and finance must be separate</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Rollout approvals</span><span class="metric-icon">${svg('check')}</span></div><div class="metric-value">${esc(activation.rolloutApprovals)}<span class="small"> / 2</span></div><span class="metric-sub">Required after a reconciled pilot</span></article><article class="card pad metric"><div class="metric-top"><span class="metric-label">Pilot payments</span><span class="metric-icon">${svg('payment')}</span></div><div class="metric-value">${esc(activation.pilotPayments.length)}</div><span class="metric-sub">Low-value, independently monitored</span></article></div><div class="grid two" style="margin-top:18px"><section class="card pad"><div class="card-heading"><div><h2>Readiness blockers</h2><p>Every item is enforced outside the allocation agent.</p></div><span class="status ${activation.allowed ? 'allowed' : 'denied'}">${activation.allowed ? 'READY' : `${activation.blockers.length} OPEN`}</span></div>${activation.blockers.length ? `<div class="control-list">${activation.blockers.map((blocker) => `<div class="control-change"><div><b>${esc(blockerLabels[blocker] || blocker.replaceAll('_', ' '))}</b><span class="code">${esc(blocker)}</span></div>${status('DENY', 'BLOCKING')}</div>`).join('')}</div>` : empty('check', 'Production gate is ready', 'All external evidence and independent approvals are current.')}</section><aside class="card pad security-panel"><div class="card-heading"><div><h2>Controlled rollout</h2><p>Limits cannot be changed by the agent.</p></div></div><div class="control"><span class="control-icon">1</span><div><b>Independent assessment</b><span>External sign-off is required before pilot activation.</span></div></div><div class="control"><span class="control-icon">2</span><div><b>Single low-value pilot</b><span>Asset, amount, count, daily exposure, fee, and expiry limits are enforced server-side.</span></div></div><div class="control"><span class="control-icon">3</span><div><b>Exact ledger confirmation</b><span>Independent monitoring must match the approved transaction digest in a validated ledger.</span></div></div><div class="control"><span class="control-icon">4</span><div><b>Freeze and rollback</b><span>Security or platform operations can stop settlement immediately.</span></div></div></aside></div>${activation.pilotPayments.length ? `<section class="card pad" style="margin-top:18px"><div class="card-heading"><div><h2>Pilot evidence</h2><p>Validated and reconciled transaction status.</p></div></div><div class="control-list">${activation.pilotPayments.map((payment) => `<div class="control-change"><div><b>${esc(payment.amountXrp)} XRP · ${esc(payment.authorizationId)}</b><span class="code">${esc(payment.transactionHash || 'Transaction not yet validated')}</span></div>${status(payment.status === 'RECONCILED' ? 'ALLOW' : 'REVIEW', payment.status)}</div>`).join('')}</div></section>` : ''}`; }

function audit() { const payments = state.data.payments; const events = payments.flatMap((payment) => [{ time: payment.createdAt, title: 'Payment intent reserved', copy: `${obligationName(payment.intent.sourceObligationId)} · ${money(payment.intent.amount)}`, kind: 'event' }, { time: payment.decision.signedAt, title: `Approval Layer ${payment.decision.decision.outcome.toLowerCase()} decision signed`, copy: `${payment.decision.decision.reasonCodes.join(', ') || 'All deterministic checks passed'} · ${compact(payment.decision.decisionDigest)}`, kind: payment.decision.decision.outcome.toLowerCase() }]).sort((a, b) => b.time.localeCompare(a.time)); return `<section class="page-heading"><div><p class="eyebrow">Evidence trail</p><h1>Audit timeline</h1><p>Payment controls and security outcomes are traceable by their server-issued correlation and decision records.</p></div>${button('Refresh', 'reload')}</section><section class="card pad">${events.length ? `<div class="timeline">${events.map((event) => `<div class="event ${event.kind === 'allow' ? 'allowed' : event.kind === 'review' ? 'review' : ''}"><div class="event-title">${esc(event.title)}</div><div class="event-copy">${esc(event.copy)}</div><div class="event-time">${when(event.time)}</div></div>`).join('')}</div>` : empty('audit', 'No audit activity yet', 'The first payment assessment will create an intent record and a security decision event.')}</section>`; }

function paymentDetail() { const payment = state.data.payments.find((item) => item.paymentId === state.activePaymentId); if (!payment) { state.route = 'payments'; return payments(); } const outcome = payment.decision.decision.outcome; const canRecover = outcome === 'ALLOW'; return `<section class="page-heading"><div><p class="eyebrow">Payment record</p><h1>${esc(obligationName(payment.intent.sourceObligationId))}</h1><p>Lifecycle and control evidence for this canonical payment intent.</p></div>${button('Back to payments', 'route-payments')}</section><div class="detail-grid"><section class="grid"><article class="card pad"><div class="card-heading"><div><h2>Payment lifecycle</h2><p>${esc(payment.paymentId)}</p></div>${status(outcome)}</div><div class="timeline"><div class="event allowed"><div class="event-title">Capacity reserved</div><div class="event-copy">${money(payment.intent.amount)} reserved from ${esc(allocationName(payment.intent.allocationId))}.</div><div class="event-time">${when(payment.createdAt)}</div></div><div class="event ${outcome === 'ALLOW' ? 'allowed' : 'review'}"><div class="event-title">Approval Layer returned ${esc(outcome)}</div><div class="event-copy">${esc(payment.decision.decision.reasonCodes.join(', ') || 'All gates completed without a reason code.')}</div><div class="event-time">${when(payment.decision.signedAt)}</div></div><div class="event"><div class="event-title">${esc(labelState(payment.state))}</div><div class="event-copy">${outcome === 'ALLOW' ? 'A separate signer and XRPL adapter must authorize and validate settlement.' : 'This item cannot advance to signing until its security outcome is resolved by the appropriate human control.'}</div></div></div></article><article class="card pad"><div class="card-heading"><div><h2>Control trace</h2><p>Deterministic checks</p></div></div>${decisionTrace(payment)}</article></section><aside class="grid"><section class="card pad"><div class="card-heading"><div><h2>Decision receipt</h2><p>Signed Approval Layer record</p></div>${svg('receipt', 'nav-icon')}</div><div class="receipt-key">Decision ID</div><div class="receipt-value code">${esc(payment.decision.decision.decisionId)}</div><div class="receipt-key">Receipt hash</div><div class="receipt-value code">${esc(payment.receiptHash || 'Pending receipt generation')}</div><div class="receipt-key">Intent digest</div><div class="receipt-value code">${esc(payment.intentDigest)}</div><div class="receipt-key">Decision digest</div><div class="receipt-value code">${esc(payment.decision.decisionDigest)}</div><div class="receipt-key">Expires</div><div class="receipt-value">${when(payment.decision.decision.expiresAt)}</div>${payment.receiptId ? button(`${svg('receipt', 'nav-icon')} Download verified receipt`, 'download-receipt', 'secondary', `data-receipt-id="${esc(payment.receiptId)}"`) : ''}${canRecover ? button(`${svg('refresh', 'nav-icon')} Recover decision`, 'recover-decision', 'secondary', `data-payment-id="${esc(payment.paymentId)}"`) : ''}</section><section class="card pad"><div class="card-heading"><div><h2>Protected instruction</h2><p>Resolved by the server</p></div></div><div class="row"><span>Amount</span><b class="amount">${money(payment.intent.amount)}</b></div><div class="row" style="margin-top:11px"><span>Beneficiary</span><b>${esc(beneficiaryName(payment.intent.beneficiaryId))}</b></div><div class="row" style="margin-top:11px"><span>Destination</span><b class="amount">Approved wallet v${payment.intent.beneficiaryWalletVersion}</b></div><div class="row" style="margin-top:11px"><span>Policy version</span><b class="amount">${esc(payment.intent.policyVersion)}</b></div></section></aside></div>`; }

function decisionTrace(payment) { return `<div class="grid" style="gap:0">${payment.checks.map((check) => `<div class="allocation-item"><div><div class="allocation-name">${esc(check.control)}</div><div class="allocation-meta">${esc(check.reasonCodes?.join(', ') || 'Control passed')}</div></div>${status(check.outcome === 'ALLOW' ? 'ALLOW' : check.outcome === 'REVIEW' ? 'REVIEW' : 'DENY', check.outcome)}</div>`).join('')}</div>`; }
function empty(icon, title, copy) { return `<div class="empty">${svg(icon)}<strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`; }
function obligationName(id) { return state.data.paymentReferences.obligations.find((item) => item.obligationId === id)?.displayName || id; }
function allocationName(id) { return state.data.paymentReferences.allocations.find((item) => item.allocationId === id)?.displayName || id; }
function beneficiaryName(id) { return state.data.paymentReferences.beneficiaries.find((item) => item.beneficiaryId === id)?.label || id; }
function labelState(value) { return ({ AWAITING_SETTLEMENT: 'Awaiting independent settlement', REVIEW_REQUIRED: 'Human review required', BLOCKED: 'Blocked', VALIDATED: 'Ledger validated — awaiting reconciliation', RECONCILED: 'Independently reconciled', RETRYABLE_FAILURE: 'Settlement retry required', FAILED: 'Settlement failed' })[value] || value; }

function updateReferencePreview() { const form = document.querySelector('#payment-form'); if (!form || !state.data) return; const obligation = state.data.paymentReferences.obligations.find((item) => item.obligationId === form.obligationId.value); if (form.beneficiaryId.value !== obligation.beneficiaryId) form.beneficiaryId.value = obligation.beneficiaryId; const beneficiary = state.data.paymentReferences.beneficiaries.find((item) => item.beneficiaryId === form.beneficiaryId.value); const allocation = state.data.paymentReferences.allocations.find((item) => item.allocationId === form.allocationId.value); const preview = document.querySelector('#reference-preview'); preview.innerHTML = `<div class="row"><span>Amount (authoritative)</span><b class="amount">${money(obligation.amount)}</b></div><div class="row"><span>Beneficiary destination</span><b>Approved ${esc(beneficiary.label)} wallet · v${beneficiary.walletVersion}</b></div><div class="row"><span>Source allocation</span><b>${esc(allocation.displayName)}</b></div><div class="row"><span>Evidence requirement</span><b>Verified invoice attached</b></div>`; }

function scrollToPageStart() {
  // Keep route changes from inheriting the previous page's document scroll position.
  // The sidebar has its own scroll container so its long navigation never shifts the main view.
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}

function bind() {
  if (voiceCapture && state.voiceState === 'LISTENING') updateVoicePreview(voiceCapture);
  document.querySelectorAll('[data-route]').forEach((element) => element.addEventListener('click', (event) => { event.preventDefault(); state.mobileMenuOpen = false; state.route = element.dataset.route; state.activePaymentId = null; state.activeBeneficiaryId = null; render(); scrollToPageStart(); if (state.route === 'allocations') refreshAllocationBalances(); }));
  document.querySelectorAll('[data-action]').forEach((element) => element.addEventListener('click', onAction));
  const form = document.querySelector('#payment-form');
  if (form) { form.addEventListener('submit', submitPayment); form.addEventListener('change', updateReferencePreview); updateReferencePreview(); }
  const agentForm = document.querySelector('#agent-form');
  if (agentForm) agentForm.addEventListener('submit', submitAgentInstruction);
  const freezeForm = document.querySelector('#emergency-freeze-form');
  if (freezeForm) freezeForm.addEventListener('submit', applyEmergencyFreeze);
  const limitForm = document.querySelector('#limit-change-form');
  if (limitForm) limitForm.addEventListener('submit', requestLimitChange);
  const allocationForm = document.querySelector('#allocation-form');
  if (allocationForm) allocationForm.addEventListener('submit', submitAllocation);
  const payeeForm = document.querySelector('#payee-form');
  if (payeeForm) payeeForm.addEventListener('submit', submitPayee);
}

async function connectXrplWallet(walletId) {
  if (!['gemwallet', 'crossmark'].includes(walletId) || state.walletConnecting) return;
  if (!walletManager) return toast('Wallet connection unavailable', 'XRPL Connect is not available in this browser.', true);
  state.walletConnecting = walletId;
  state.walletInstallProvider = null;
  render();
  try {
    const account = await walletManager.connect(walletId);
    if (!account?.address) throw new Error('The wallet did not return an XRPL account.');
    state.walletPickerOpen = false;
  } catch (error) {
    const code = String(error?.code || '');
    const message = String(error?.message || 'Could not connect to this XRPL wallet.');
    if (walletId === 'gemwallet' && /incomplete network|network information|network.*unknown/i.test(message)) {
      try {
        await connectGemWalletDirect();
        toast('GemWallet connected', 'Alloc-X normalized the current GemWallet Testnet account.');
      } catch (fallbackError) {
        if (fallbackError.code === 'WALLET_NOT_INSTALLED') state.walletInstallProvider = walletId;
        else toast('Wallet could not connect', fallbackError.message, true);
      }
    } else if (code === 'WALLET_NOT_AVAILABLE' || code === 'WALLET_NOT_INSTALLED' || /not available|not installed|not detected|extension/i.test(message)) {
      state.walletInstallProvider = walletId;
    } else if (!/rejected|cancelled|canceled/i.test(message) && code !== 'CONNECTION_REJECTED') {
      toast('Wallet could not connect', message, true);
    }
  } finally {
    state.walletConnecting = null;
    render();
  }
}

async function onAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === 'enter-workspace') return enterWorkspace();
  if (action === 'wallet-modal-close') { state.walletPickerOpen = false; state.walletInstallProvider = null; state.pendingAllocationWalletId = null; render(); return; }
  if (action === 'wallet-select') return connectXrplWallet(event.currentTarget.dataset.walletId);
  if (action === 'mobile-menu') { state.mobileMenuOpen = !state.mobileMenuOpen; render(); return; }
  if (action === 'wallet-connect') { state.walletPickerOpen = true; state.walletInstallProvider = null; render(); return; }
  if (action === 'wallet-disconnect') {
    try { await walletManager?.disconnect(); } catch (error) { toast('Wallet disconnect failed', error.message, true); }
    state.wallet = { status: 'DISCONNECTED', account: null, name: null, balance: null, error: null };
    render();
    return;
  }
  if (action === 'wallet-refresh') return refreshWalletBalance();
  if (action === 'add-allocation') { state.registryDialog = 'allocation'; render(); return; }
  if (action === 'add-payee') { state.registryDialog = 'payee'; render(); return; }
  if (action === 'registry-close') { state.registryDialog = null; render(); return; }
  if (action === 'use-connected-wallet') {
    const input = document.querySelector('#allocationWallet');
    if (input && state.wallet.account) input.value = state.wallet.account;
    return;
  }
  if (action === 'connect-allocation-wallet') {
    state.pendingAllocationWalletId = event.currentTarget.dataset.allocationId;
    state.walletPickerOpen = true;
    state.walletInstallProvider = null;
    render();
    return;
  }
  if (action === 'refresh-allocation') return refreshAllocationBalance(event.currentTarget.dataset.allocationId, true);
  if (action === 'remove-allocation') return removeRegisteredAllocation(event.currentTarget.dataset.allocationId);
  if (action === 'remove-payee') return removeRegisteredPayee(event.currentTarget.dataset.payeeId);
  if (action === 'voice-toggle') return toggleVoiceCapture();
  if (action === 'voice-confirm') return confirmVoiceInstruction();
  if (action === 'voice-discard') { state.voiceInstruction = null; state.voiceTranscript = ''; state.voiceState = 'IDLE'; render(); return; }
  if (action === 'reload') { await load(); await refreshWalletBalance(); return refreshAllocationBalances(); }
  if (action === 'route-allocations') { state.route = 'allocations'; render(); scrollToPageStart(); refreshAllocationBalances(); return; }
  if (action === 'route-new-payment') { state.route = 'new-payment'; render(); scrollToPageStart(); return; }
  if (action === 'route-payments') { state.route = 'payments'; render(); scrollToPageStart(); return; }
  if (action === 'route-beneficiaries') { state.route = 'beneficiaries'; render(); scrollToPageStart(); return; }
  if (action === 'open-payment') { state.activePaymentId = event.currentTarget.dataset.paymentId; state.route = 'payment-detail'; render(); scrollToPageStart(); return; }
  if (action === 'open-beneficiary') { state.activeBeneficiaryId = event.currentTarget.dataset.beneficiaryId; state.route = 'beneficiary-detail'; render(); scrollToPageStart(); return; }
  if (action === 'recover-decision') return recoverDecision(event.currentTarget.dataset.paymentId);
  if (action === 'download-receipt') return downloadReceipt(event.currentTarget.dataset.receiptId);
  if (action === 'release-freeze') return releaseEmergencyFreeze(event.currentTarget.dataset.freezeId);
  if (action === 'approve-limit-change') return advanceLimitChange(event.currentTarget.dataset.changeId, 'approve');
  if (action === 'escalate-limit-change') return advanceLimitChange(event.currentTarget.dataset.changeId, 'escalate');
}

function persistRegistry(registry) {
  state.registry = writeWorkspaceRegistry(registry);
}

function submitAllocation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = addAllocation(state.registry, {
      name: form.name.value,
      category: form.category.value,
      purpose: form.purpose.value,
      spendingRule: form.spendingRule.value,
      walletAddress: form.walletAddress.value,
    });
    persistRegistry(result.registry);
    state.registryDialog = null;
    render();
    refreshAllocationBalance(result.allocation.allocationId);
    toast('Allocation created', `${result.allocation.name} is ready${result.allocation.walletAddress ? ' with its Testnet wallet' : ' for a wallet connection'}.`);
  } catch (error) {
    toast('Allocation could not be created', error.message, true);
  }
}

function submitPayee(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = addPayee(state.registry, { name: form.name.value, type: form.type.value, role: form.role.value, walletAddress: form.walletAddress.value });
    persistRegistry(result.registry);
    state.registryDialog = null;
    render();
    toast('Payee registered', `${result.payee.name} passed XRPL address validation and duplicate checks.`);
  } catch (error) {
    toast('Payee could not be registered', error.message, true);
  }
}

function removeRegisteredAllocation(allocationId) {
  const allocation = state.registry.allocations.find((item) => item.allocationId === allocationId);
  if (!allocation || !globalThis.confirm(`Remove ${allocation.name}? This removes the workspace entry but does not affect the XRPL wallet.`)) return;
  persistRegistry(removeAllocation(state.registry, allocationId));
  delete state.allocationBalances[allocationId];
  render();
  toast('Allocation removed', `${allocation.name} is no longer available to Alloc-X.`);
}

function removeRegisteredPayee(payeeId) {
  const payee = state.registry.payees.find((item) => item.payeeId === payeeId);
  if (!payee || !globalThis.confirm(`Remove ${payee.name}? Future payments will no longer be able to select this payee.`)) return;
  persistRegistry(removePayee(state.registry, payeeId));
  render();
  toast('Payee removed', `${payee.name} was removed from the directory.`);
}

async function refreshAllocationBalance(allocationId, announce = false) {
  const allocation = state.registry.allocations.find((item) => item.allocationId === allocationId);
  if (!allocation?.walletAddress) return;
  state.allocationBalances[allocationId] = { status: 'LOADING' };
  if (state.data && (state.route === 'allocations' || state.route === 'overview')) render();
  try {
    const balance = await api(`/api/xrpl/testnet/accounts/${encodeURIComponent(allocation.walletAddress)}`);
    if (!state.registry.allocations.some((item) => item.allocationId === allocationId && item.walletAddress === allocation.walletAddress)) return;
    state.allocationBalances[allocationId] = { status: 'READY', ...balance };
    if (announce) toast('Balance refreshed', `${allocation.name} has ${money(balance.balanceXrp)} on XRPL Testnet.`);
  } catch (error) {
    state.allocationBalances[allocationId] = { status: 'ERROR', error: error.message };
    if (announce) toast('Balance unavailable', error.message, true);
  }
  if (state.data && (state.route === 'allocations' || state.route === 'overview')) render();
}

async function refreshAllocationBalances() {
  const linked = state.registry.allocations.filter((allocation) => allocation.walletAddress);
  await Promise.all(linked.map((allocation) => refreshAllocationBalance(allocation.allocationId)));
}

async function submitPayment(event) { event.preventDefault(); if (state.busy) return; const form = event.currentTarget; state.busy = true; render(); try { const response = await api('/api/payments', { method: 'POST', body: JSON.stringify({ obligationId: form.obligationId.value, allocationId: form.allocationId.value, beneficiaryId: form.beneficiaryId.value }) }); state.data = await api('/api/bootstrap'); state.activePaymentId = response.payment.paymentId; state.route = 'payment-detail'; toast('Payment assessment recorded', response.message); } catch (error) { toast(/insufficient|allocation.*capacity|reserve|available balance|funds/i.test(error.message) ? 'Selected funding source cannot cover this payment' : 'Payment could not be created', error.message, true); } finally { state.busy = false; render(); } }

async function submitAgentInstruction(event) { event.preventDefault(); if (state.busy) return; const form = event.currentTarget; state.busy = true; render(); try { const result = await api('/api/agent/sessions/agent_console_operator/messages', { method: 'POST', body: JSON.stringify({ message: form.message.value }) }); state.agentSession = result.session; toast('Allocation agent updated', result.message); } catch (error) { toast('Agent instruction could not be processed', error.message, true); } finally { state.busy = false; render(); } }

let activeRecognition = null;
let voiceCapture = null;

// Browsers can end a speech-recognition session after a brief pause.
// Continue capturing segments until the operator explicitly presses Stop.
function capturedVoice(session, current = '', interim = '') {
  return [...session.parts, current, interim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function updateVoicePreview(session, current = '', interim = '') {
  const preview = document.querySelector('#voice-live-transcript');
  if (preview) preview.textContent = capturedVoice(session, current, interim) || 'Listening… speak naturally and pause whenever you need.';
}

function toggleVoiceCapture() {
  if (voiceCapture && state.voiceState === 'LISTENING') {
    const session = voiceCapture;
    session.stopRequested = true;
    if (session.restartTimer) clearTimeout(session.restartTimer);
    if (activeRecognition) {
      try { activeRecognition.stop(); } catch { finishVoiceCapture(session); }
    } else {
      finishVoiceCapture(session);
    }
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    state.voiceState = 'ERROR';
    state.voiceTranscript = 'Speech recognition is unavailable in this browser. Try Chrome with microphone access, or type your instruction.';
    render();
    return;
  }
  if (voiceCapture || state.voiceState === 'PROCESSING') return;
  const session = { Recognition, parts: [], stopRequested: false, finalized: false, restartTimer: null, error: null, confidence: undefined };
  voiceCapture = session;
  state.voiceInstruction = null;
  state.voiceTranscript = '';
  state.voiceState = 'LISTENING';
  render();
  startVoiceSegment(session);
}

function startVoiceSegment(session) {
  if (voiceCapture !== session || session.stopRequested || session.finalized) return;
  const recognition = new session.Recognition();
  activeRecognition = recognition;
  recognition.lang = 'en-NG';
  recognition.interimResults = true;
  recognition.continuous = true;
  let segmentText = '';
  let segmentInterim = '';

  recognition.onresult = (event) => {
    if (voiceCapture !== session) return;
    const finalized = [];
    const interim = [];
    for (const result of Array.from(event.results)) {
      const text = result[0]?.transcript?.trim();
      if (!text) continue;
      (result.isFinal ? finalized : interim).push(text);
      if (result.isFinal && Number.isFinite(result[0]?.confidence)) session.confidence = result[0].confidence;
    }
    // Rebuild from this recognition session's results to avoid duplicated finals.
    segmentText = finalized.join(' ');
    segmentInterim = interim.join(' ');
    updateVoicePreview(session, segmentText, segmentInterim);
  };
  recognition.onerror = (event) => {
    if (voiceCapture !== session || session.stopRequested) return;
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    session.error = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Microphone or speech recognition permission was denied. Check your browser permissions.'
      : event.error === 'audio-capture' ? 'The microphone is unavailable. Check your audio input.' : 'Speech recognition stopped (' + event.error + '). Your transcript has not been submitted.';
    session.stopRequested = true;
  };
  recognition.onend = () => {
    if (voiceCapture !== session) return;
    if (segmentText.trim()) session.parts.push(segmentText.trim());
    activeRecognition = null;
    updateVoicePreview(session);
    if (session.stopRequested || session.error) {
      finishVoiceCapture(session);
      return;
    }
    // Chrome may end a recognition instance during silence; start a fresh one.
    session.restartTimer = setTimeout(() => startVoiceSegment(session), 350);
  };
  try { recognition.start(); }
  catch (error) {
    session.error = 'Speech recognition could not start. Check the microphone permission and try again.';
    session.stopRequested = true;
    finishVoiceCapture(session);
  }
}

async function finishVoiceCapture(session) {
  if (voiceCapture !== session || session.finalized) return;
  session.finalized = true;
  if (session.restartTimer) clearTimeout(session.restartTimer);
  voiceCapture = null;
  activeRecognition = null;
  const transcript = capturedVoice(session);
  if (session.error) {
    state.voiceState = 'ERROR';
    state.voiceTranscript = session.error + (transcript ? ' Captured text: ' + transcript : '');
    render();
    return;
  }
  if (!transcript) {
    state.voiceState = 'ERROR';
    state.voiceTranscript = 'No speech was captured. Speak your instruction and press Stop when you have finished.';
    render();
    return;
  }
  if (transcript.length > 2000) {
    state.voiceState = 'ERROR';
    state.voiceTranscript = 'Your recording exceeded the 2,000-character transcript limit. Please record a shorter instruction.';
    render();
    return;
  }
  state.voiceState = 'PROCESSING';
  state.voiceTranscript = transcript;
  state.voiceConfidence = session.confidence;
  render();
  try {
    const result = await api('/api/voice/instructions', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'agent_console_operator',
        transcript,
        recognition: {
          engine: 'browser-native',
          locale: 'en-NG',
          ...(typeof session.confidence === 'number' ? { confidence: session.confidence } : {}),
        },
      }),
    });
    state.voiceInstruction = result.instruction;
    state.voiceState = 'REVIEW';
    render();
    toast('Transcript ready for review', 'Review the complete recording before confirming a financial instruction.');
  } catch (error) {
    state.voiceState = 'ERROR';
    state.voiceTranscript = 'Transcript could not be saved: ' + error.message + '. Captured text: ' + transcript;
    render();
  }
}

async function confirmVoiceInstruction() { const instruction = state.voiceInstruction; if (!instruction || state.busy) return; state.busy = true; render(); try { const result = await api(`/api/voice/instructions/${encodeURIComponent(instruction.voiceInstructionId)}/confirm`, { method: 'POST', body: JSON.stringify({ transcript: instruction.transcript }) }); state.agentSession = result.session; state.voiceInstruction = null; state.voiceTranscript = ''; state.voiceState = 'IDLE'; toast('Voice instruction confirmed', result.message); } catch (error) { toast('Voice confirmation could not continue', error.message, true); } finally { state.busy = false; render(); } }

async function recoverDecision(paymentId) { try { const result = await api(`/api/payments/${encodeURIComponent(paymentId)}/recover`, { method: 'POST', body: '{}' }); toast('Decision recovered', `The durable record ${compact(result.recovered.recordHash)} was verified for this intent.`); } catch (error) { toast('Recovery unavailable', error.message, true); } }
function downloadReceipt(receiptId) { window.location.assign(`/api/receipts/${encodeURIComponent(receiptId)}/download`); }
async function applyEmergencyFreeze(event) { event.preventDefault(); const form = event.currentTarget; const scope = form.scope.value === 'organization' ? { kind: 'organization' } : form.scope.value === 'asset' ? { kind: 'asset', asset: 'XRP' } : { kind: 'beneficiary', beneficiaryId: 'ben_medtech' }; try { const result = await api('/api/security/freeze', { method: 'POST', body: JSON.stringify({ scope, reason: form.reason.value }) }); state.data = await api('/api/bootstrap'); render(); toast('Emergency freeze applied', result.message); } catch (error) { toast('Freeze could not be applied', error.message, true); } }
async function releaseEmergencyFreeze(freezeId) { try { const result = await api(`/api/security/freeze/${encodeURIComponent(freezeId)}/release`, { method: 'POST', body: JSON.stringify({ reason: 'Security review completed and release authorized.' }) }); state.data = await api('/api/bootstrap'); render(); toast('Emergency freeze released', result.message); } catch (error) { toast('Release unavailable', error.message, true); } }
async function requestLimitChange(event) { event.preventDefault(); const form = event.currentTarget; try { const result = await api('/api/security/limit-changes', { method: 'POST', body: JSON.stringify({ control: form.control.value, currentValue: currentLimit(form.control.value), requestedValue: form.requestedValue.value, justification: form.justification.value }) }); state.data = await api('/api/bootstrap'); render(); toast('Control change recorded', result.message); } catch (error) { toast('Change could not be recorded', error.message, true); } }
async function advanceLimitChange(changeId, action) { try { const result = await api(`/api/security/limit-changes/${encodeURIComponent(changeId)}/${action}`, { method: 'POST', body: '{}' }); state.data = await api('/api/bootstrap'); render(); toast(action === 'approve' ? 'Independent approval recorded' : 'Independent escalation recorded', result.message); } catch (error) { toast('Control change could not advance', error.message, true); } }
function toast(title, text, error = false) { const region = document.querySelector('#toast-region'); const item = document.createElement('div'); item.className = `toast${error ? ' error' : ''}`; item.innerHTML = `<strong>${esc(title)}</strong><span>${esc(text)}</span>`; region.append(item); setTimeout(() => item.remove(), 6500); }

initializeWalletConnection();
showLanding();
