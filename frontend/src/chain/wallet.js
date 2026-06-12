const listeners = new Set();
let providers = [];
let provider = null;
let account = '';
let status = '';
let discoveryStarted = false;
let stopAccountListener = null;

export function getWalletState() {
  return { providers: [...providers], provider, account, status, connected: Boolean(account && provider) };
}

export function subscribeWallet(listener) {
  listeners.add(listener);
  listener(getWalletState());
  return () => listeners.delete(listener);
}

export function startWalletDiscovery() {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  providers = uniqueWalletProviders(discoverInjectedProviders());
  notify();

  const onAnnounce = (event) => {
    const detail = event.detail;
    if (!detail?.provider) return;
    providers = uniqueWalletProviders([...providers, detail]);
    notify();
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export async function connectWallet({ forceSelection = true } = {}) {
  startWalletDiscovery();
  if (providers.length === 0) {
    status = 'NO WALLET';
    notify();
    throw new Error('Wallet not found. Install or unlock an EVM wallet.');
  }

  const selected = forceSelection || !provider
    ? await chooseWalletProvider({ providers, currentProvider: provider })
    : { provider };
  const nextProvider = selected?.provider || null;
  if (!nextProvider?.request) throw new Error('Wallet was not selected.');

  status = 'CONNECTING...';
  notify();
  let nextAccount = '';
  try {
    nextAccount = await requestWalletAccount(nextProvider);
    if (!nextAccount) throw new Error('Wallet account was not returned.');
  } catch (error) {
    status = walletStatusFromError(error);
    notify();
    throw error;
  }

  setSelectedWallet(nextProvider, normalizeAddress(nextAccount));
  status = '';
  notify();
  return getWalletState();
}

function walletStatusFromError(error) {
  const message = error?.message || String(error);
  if (message === 'wallet_request_rejected') return 'REJECTED';
  if (message === 'wallet_request_already_pending') return 'OPEN WALLET';
  return account ? '' : 'CONNECT WALLET';
}

export function setSelectedWallet(nextProvider, nextAccount) {
  provider = nextProvider || null;
  account = nextAccount || '';
  bindAccountChanges();
  notify();
}

export function shortAddress(value) {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function bindAccountChanges() {
  stopAccountListener?.();
  stopAccountListener = null;
  if (!provider?.on) return;
  const onAccountsChanged = (accounts = []) => {
    account = accounts?.[0] ? normalizeAddress(accounts[0]) : '';
    status = account ? '' : 'CONNECT WALLET';
    notify();
  };
  provider.on('accountsChanged', onAccountsChanged);
  stopAccountListener = () => provider.removeListener?.('accountsChanged', onAccountsChanged);
}

function notify() {
  const state = getWalletState();
  for (const listener of listeners) listener(state);
}

function discoverInjectedProviders() {
  if (typeof window === 'undefined' || !window.ethereum) return [];
  const list = window.ethereum.providers?.length ? window.ethereum.providers : [window.ethereum];
  return list.map((item, index) => ({
    provider: item,
    info: {
      name: walletProviderLabel(item, {}, index),
      rdns: item.isPhantom ? 'app.phantom' : isStrictMetaMaskProvider(item) ? 'io.metamask' : item.isCoinbaseWallet ? 'com.coinbase.wallet' : '',
    },
  }));
}

function uniqueWalletProviders(items = []) {
  const unique = [];
  for (const item of items) {
    if (item?.provider && !unique.some((existing) => existing.provider === item.provider)) unique.push(item);
  }
  return unique;
}

function chooseWalletProvider({ providers: available, currentProvider }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'wallet-select-modal';
    overlay.style.cssText = `position:fixed;inset:0;z-index:80;display:grid;place-items:center;
      background:rgba(0,0,0,.64);font-family:'Courier New',monospace;color:#f8fbff;padding:18px;box-sizing:border-box`;
    const modal = document.createElement('div');
    modal.style.cssText = `width:min(520px,100%);background:#101820;border:4px solid #000;border-radius:8px;
      box-shadow:7px 7px 0 rgba(0,0,0,.5);padding:18px;box-sizing:border-box`;
    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <h2 style="margin:0;color:#ffdd55;font-size:24px;text-shadow:2px 2px 0 #000">Choose wallet</h2>
        <button type="button" data-close style="${modalBtnCss('#cdd3da')}font-size:14px;padding:8px 12px">CLOSE</button>
      </div>
      <div style="display:grid;gap:10px">
        ${available.map((item, index) => {
          const active = item.provider === currentProvider;
          return `
            <button type="button" data-wallet="${index}" style="${modalBtnCss(active ? '#7CFFB0' : '#1d2730')}color:${active ? '#07150d' : '#f8fbff'};text-align:left;
              display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:16px;padding:13px 14px">
              <span>${escapeHtml(walletProviderLabel(item.provider, item.info, index))}${active ? ' · connected' : ''}</span>
              <span style="color:${active ? '#284232' : '#9db0bf'};font-size:12px">${escapeHtml(item.info?.rdns || 'browser wallet')}</span>
            </button>
          `;
        }).join('')}
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (item = null) => {
      overlay.remove();
      resolve(item);
    };
    modal.querySelector('[data-close]').onclick = () => close(null);
    overlay.onclick = (event) => {
      if (event.target === overlay) close(null);
    };
    modal.querySelectorAll('[data-wallet]').forEach((button) => {
      button.onclick = () => close(available[Number(button.dataset.wallet)]);
    });
  });
}

function modalBtnCss(bg = '#ffdd55') {
  return `font-family:'Courier New',monospace;font-weight:bold;color:#222;background:${bg};
    border:3px solid #000;border-radius:12px;cursor:pointer;letter-spacing:1px;
    box-shadow:3px 3px 0 rgba(0,0,0,.35);transition:transform .08s ease;`;
}

async function requestWalletAccount(selectedProvider) {
  try {
    await selectedProvider.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    const accounts = await selectedProvider.request({ method: 'eth_accounts' });
    return accounts?.[0] || '';
  } catch (error) {
    if (error?.code === 4001) throw new Error('wallet_request_rejected');
    if (error?.code === -32002) throw new Error('wallet_request_already_pending');
    if (error?.code !== -32601 && error?.code !== -32603) throw error;
  }

  const accounts = await selectedProvider.request({ method: 'eth_requestAccounts' }).catch((error) => {
    if (error?.code === 4001) throw new Error('wallet_request_rejected');
    if (error?.code === -32002) throw new Error('wallet_request_already_pending');
    throw error;
  });
  return accounts?.[0] || '';
}

function isStrictMetaMaskProvider(item) {
  return Boolean(item?._metamask) || Boolean(item?.isMetaMask && !item?.isPhantom && !item?.isCoinbaseWallet);
}

function walletProviderLabel(item, info = {}, index = 0) {
  if (info?.name) return info.name;
  if (item?.isPhantom) return 'Phantom';
  if (item?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (isStrictMetaMaskProvider(item)) return 'MetaMask';
  return index ? `Wallet ${index + 1}` : 'Browser wallet';
}

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
