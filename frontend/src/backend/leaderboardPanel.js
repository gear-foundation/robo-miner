import { btnCss, wireBtn } from '../scenes/arenaUI.js';
import { generateAgentName } from '../agentNames.js';
import { backendEnabled, fetchLeaderboard } from './api.js';
import { connectWallet, getWalletState, startWalletDiscovery, subscribeWallet } from '../chain/wallet.js';

const DEFAULT_PAGE_SIZE = 5;
const DEFAULT_LIMIT = 200;

export function createLeaderboardPanel({
  id = 'leaderboard-panel',
  className = '',
  style = '',
  pageSize = DEFAULT_PAGE_SIZE,
  limit = DEFAULT_LIMIT,
} = {}) {
  const state = {
    rows: [],
    metric: 'earned',
    page: 0,
    loading: false,
    error: '',
    destroyed: false,
    wallet: getWalletState(),
  };

  const root = document.createElement('section');
  root.id = id;
  root.className = className;
  root.style.cssText = `background:#21170f;border:3px solid #000;border-radius:8px;
    box-shadow:5px 5px 0 rgba(0,0,0,.38);overflow:hidden;color:#fff;display:flex;flex-direction:column;
    font-family:'Courier New',monospace;box-sizing:border-box;${style}`;

  const pageCount = () => Math.max(1, Math.ceil((state.rows?.length || 0) / pageSize));
  const visibleRows = () => state.rows.slice(state.page * pageSize, state.page * pageSize + pageSize);
  const myRowIndex = () => state.rows.findIndex((row) => rowMatchesWallet(row, state.wallet?.account));
  const myRow = () => {
    const index = myRowIndex();
    return index >= 0 ? state.rows[index] : null;
  };

  function render() {
    if (state.destroyed) return;
    root.innerHTML = '';

    const head = document.createElement('div');
    head.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:12px 16px;background:#362314;border-bottom:3px solid #000;flex-wrap:wrap;flex:0 0 auto`;

    const title = document.createElement('div');
    title.style.cssText = 'font-size:22px;font-weight:bold;color:#ffdd55;text-shadow:2px 2px 0 #000';
    title.textContent = 'LEADERBOARD';
    head.appendChild(title);

    const caption = document.createElement('div');
    caption.style.cssText = 'font-size:14px;color:#cdd3da;opacity:.82;text-align:right';
    caption.textContent = 'RES brought to surface';
    head.appendChild(caption);
    root.appendChild(head);

    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px 12px;overflow:visible;flex:0 0 auto;min-width:0';
    root.appendChild(body);

    if (!backendEnabled()) {
      body.appendChild(message('Backend leaderboard is offline.', '#cdd3da'));
      return;
    }
    if (state.loading) {
      body.appendChild(message('Loading leaderboard...', '#7CFFB0'));
      return;
    }
    if (state.error) {
      body.appendChild(message('Leaderboard unavailable.', '#ff9f7c'));
      return;
    }
    if (!state.rows.length) {
      body.appendChild(message('No leaderboard rows yet.', '#cdd3da'));
      return;
    }

    body.appendChild(myRankCard());

    const table = document.createElement('div');
    table.className = 'leaderboard-grid';
    table.style.cssText = 'display:grid;gap:0;align-items:center;font-size:16px;width:100%;min-width:0';
    for (const [index, label] of ['#', 'AGENT', 'SCORE', 'RES', 'MOVES'].entries()) {
      const cell = document.createElement('div');
      cell.className = `leaderboard-cell leaderboard-col-${columnName(index)}`;
      cell.textContent = label;
      cell.style.cssText = 'padding:9px 14px;color:#ffdd55;border-bottom:3px solid #000;font-weight:bold;opacity:.95';
      table.appendChild(cell);
    }

    for (const row of visibleRows()) {
      const resources = row.earned || {};
      const agentName = row.agentName || generateAgentName(row.diggerProgramId || row.ownerActor);
      const isMine = rowMatchesWallet(row, state.wallet?.account);
      const cells = [
        { text: String(row.rank || '') },
        {
          agent: true,
          name: agentName,
          address: shortId(displayEvmAddress(row.ownerActor)),
          fullAddress: displayEvmAddress(row.ownerActor),
        },
        { text: formatNumber(row.score || 0), score: true },
        { text: `${resources.scrst || 0}/${resources.bcrst || 0}/${resources.hcrst || 0}` },
        { text: formatNumber(row.moves || 0) },
      ];
      for (let i = 0; i < cells.length; i += 1) {
        const cell = document.createElement('div');
        cell.className = `leaderboard-cell leaderboard-col-${columnName(i)}`;
        if (cells[i].agent) {
          const name = document.createElement('div');
          name.textContent = cells[i].name;
          name.style.cssText = 'font-weight:bold;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          const address = document.createElement('div');
          address.style.cssText = `margin-top:2px;font-size:12px;color:#9bb0a4;display:flex;align-items:center;
            gap:5px;min-width:0;white-space:nowrap`;
          const addressText = document.createElement('span');
          addressText.textContent = cells[i].address;
          addressText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;min-width:0';
          address.append(addressText, copyAddressButton(cells[i].fullAddress));
          cell.append(name, address);
          cell.title = `${cells[i].name} · ${cells[i].fullAddress}`;
        } else {
          cell.textContent = cells[i].text;
        }
        cell.style.cssText = `min-height:54px;padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.09);
          overflow:hidden;text-overflow:ellipsis;white-space:${cells[i].agent ? 'normal' : 'nowrap'};
          background:${isMine ? 'rgba(124,255,176,.12)' : 'transparent'};
          box-shadow:${isMine ? 'inset 0 0 0 2px rgba(124,255,176,.22)' : 'none'};
          color:${cells[i].score ? '#7CFFB0' : '#fff'}`;
        table.appendChild(cell);
      }
    }
    body.appendChild(table);

    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:12px;flex-wrap:wrap';
    const page = document.createElement('div');
    page.style.cssText = 'font-size:15px;color:#cdd3da;opacity:.86';
    page.textContent = `Page ${state.page + 1} of ${pageCount()} · ${state.rows.length} agents`;
    foot.appendChild(page);

    const pager = document.createElement('div');
    pager.style.cssText = 'display:flex;gap:7px';
    pager.append(
      pageButton('‹', () => setPage(state.page - 1), state.page <= 0),
      pageButton('›', () => setPage(state.page + 1), state.page >= pageCount() - 1),
    );
    foot.appendChild(pager);
    body.appendChild(foot);
  }

  async function refresh() {
    if (!backendEnabled()) {
      render();
      return;
    }
    state.loading = true;
    state.error = '';
    render();
    try {
      state.rows = await fetchLeaderboard({ metric: 'earned', limit });
      state.page = Math.min(state.page, pageCount() - 1);
    } catch (error) {
      state.rows = [];
      state.page = 0;
      state.error = error instanceof Error ? error.message : String(error);
      console.warn('[backend] failed to load leaderboard', error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function setPage(page) {
    state.page = Math.max(0, Math.min(page, pageCount() - 1));
    render();
  }

  function pageButton(label, onClick, disabled) {
    const btn = wireBtn(document.createElement('button'));
    btn.textContent = label;
    btn.disabled = disabled;
    btn.style.cssText = btnCss(disabled ? '#555' : '#cdd3da') + 'font-size:22px;padding:6px 14px;min-width:50px';
    btn.style.opacity = disabled ? '.45' : '1';
    btn.onclick = disabled ? null : onClick;
    return btn;
  }

  function message(text, color) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `padding:16px;text-align:center;color:${color};opacity:.78;font-size:12px`;
    return el;
  }

  function myRankCard() {
    const row = myRow();
    const index = myRowIndex();
    const account = state.wallet?.account || '';
    const card = document.createElement('div');
    card.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:14px;
      margin:0 0 10px;padding:9px 12px;background:#101821;border:3px solid #000;border-radius:8px;
      box-shadow:4px 4px 0 rgba(0,0,0,.32);font-size:15px;flex-wrap:wrap`;

    if (account && row) {
      const agentName = row.agentName || generateAgentName(row.diggerProgramId || row.ownerActor);
      card.innerHTML = `<div><span style="color:#ffdd55;font-weight:bold">YOUR RANK</span> ` +
        `<b style="color:#7CFFB0;font-size:20px">#${row.rank}</b> ` +
        `<span style="color:#fff">${escapeHtml(agentName)}</span> ` +
        `<span style="color:#9bb0a4">${escapeHtml(shortId(displayEvmAddress(row.ownerActor)))}</span></div>` +
        `<div style="color:#cdd3da">score <b style="color:#7CFFB0">${formatNumber(row.score || 0)}</b></div>`;
      card.firstElementChild?.appendChild(copyAddressButton(displayEvmAddress(row.ownerActor)));
      const jump = rankButton('SHOW ME', () => setPage(Math.floor(index / pageSize)));
      card.appendChild(jump);
      return card;
    }

    if (account) {
      card.innerHTML = `<div><span style="color:#ffdd55;font-weight:bold">YOUR RANK</span> ` +
        `<span style="color:#cdd3da">No surfaced RES on this leaderboard yet.</span> ` +
        `<span style="color:#9bb0a4">${escapeHtml(shortId(displayEvmAddress(ownerActorFromAddress(account))))}</span></div>`;
      card.firstElementChild?.appendChild(copyAddressButton(account));
      return card;
    }

    card.innerHTML = `<div><span style="color:#ffdd55;font-weight:bold">YOUR RANK</span> ` +
      `<span style="color:#cdd3da">Connect wallet to highlight your place.</span></div>`;
    card.appendChild(rankButton('CONNECT', () => connectWallet({ forceSelection: true }).catch(() => null)));
    return card;
  }

  function rankButton(label, onClick) {
    const btn = wireBtn(document.createElement('button'));
    btn.textContent = label;
    btn.style.cssText = btnCss('#7CFFB0') + 'font-size:14px;padding:8px 12px;min-width:96px';
    btn.onclick = onClick;
    return btn;
  }

  startWalletDiscovery();
  const unsubscribeWallet = subscribeWallet((wallet) => {
    state.wallet = wallet;
    render();
  });
  render();
  refresh();

  return {
    element: root,
    refresh,
    destroy() {
      state.destroyed = true;
      unsubscribeWallet?.();
      root.remove();
    },
  };
}

function rowMatchesWallet(row, account) {
  if (!account) return false;
  const actor = ownerActorFromAddress(account);
  const ownerActor = String(row?.ownerActor || '').toLowerCase();
  const accountText = String(account || '').toLowerCase();
  return ownerActor === actor || ownerActor.endsWith(accountText.slice(2));
}

function ownerActorFromAddress(address) {
  const clean = String(address || '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) return '';
  return `0x${'00'.repeat(12)}${clean}`;
}

function displayEvmAddress(value) {
  const text = String(value || '');
  const clean = text.toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{64}$/.test(clean) && clean.startsWith('0'.repeat(24))) {
    return `0x${clean.slice(24)}`;
  }
  return text;
}

function columnName(index) {
  return ['rank', 'agent', 'score', 'res', 'moves'][index] || 'unknown';
}

function copyAddressButton(address) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '⧉';
  btn.title = 'Copy address';
  btn.setAttribute('aria-label', `Copy address ${address}`);
  btn.style.cssText = `appearance:none;border:1px solid #806544;border-radius:4px;background:#17100a;color:#ffdd55;
    min-width:24px;height:22px;padding:0 5px;font:700 14px/20px 'Courier New',monospace;cursor:pointer;flex:0 0 auto`;
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await copyText(address);
      btn.textContent = '✓';
      btn.style.color = '#7CFFB0';
      btn.title = 'Copied';
    } catch {
      btn.textContent = '!';
      btn.style.color = '#ff9f7c';
      btn.title = 'Copy failed';
    }
    window.setTimeout(() => {
      if (!btn.isConnected) return;
      btn.textContent = '⧉';
      btn.style.color = '#ffdd55';
      btn.title = 'Copy address';
    }, 1200);
  });
  return btn;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 18) return text || '-';
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
