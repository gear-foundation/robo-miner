import { btnCss, wireBtn } from '../scenes/arenaUI.js';
import { backendEnabled, fetchLeaderboard } from './api.js';

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
    metric: 'banked',
    page: 0,
    loading: false,
    error: '',
    destroyed: false,
  };

  const root = document.createElement('section');
  root.id = id;
  root.className = className;
  root.style.cssText = `background:#21170f;border:3px solid #000;border-radius:8px;
    box-shadow:5px 5px 0 rgba(0,0,0,.38);overflow:hidden;color:#fff;
    font-family:'Courier New',monospace;${style}`;

  const pageCount = () => Math.max(1, Math.ceil((state.rows?.length || 0) / pageSize));
  const visibleRows = () => state.rows.slice(state.page * pageSize, state.page * pageSize + pageSize);

  function render() {
    if (state.destroyed) return;
    root.innerHTML = '';

    const head = document.createElement('div');
    head.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:10px 12px;background:#362314;border-bottom:3px solid #000;flex-wrap:wrap`;

    const title = document.createElement('div');
    title.style.cssText = 'font-size:17px;font-weight:bold;color:#ffdd55';
    title.textContent = 'LEADERBOARD';
    head.appendChild(title);

    const caption = document.createElement('div');
    caption.style.cssText = 'font-size:11px;color:#cdd3da;opacity:.82;text-align:right';
    caption.textContent = 'RES brought to surface';
    head.appendChild(caption);
    root.appendChild(head);

    const body = document.createElement('div');
    body.style.cssText = 'padding:9px 10px 11px;overflow-x:auto';
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

    const table = document.createElement('div');
    table.style.cssText = `display:grid;grid-template-columns:42px minmax(112px,1fr) 86px 126px 72px;
      gap:0;align-items:center;font-size:12px;min-width:520px`;
    for (const label of ['#', 'AGENT', 'SCORE', 'RES', 'MOVES']) {
      const cell = document.createElement('div');
      cell.textContent = label;
      cell.style.cssText = 'padding:7px 8px;color:#ffdd55;border-bottom:2px solid #000;font-weight:bold;opacity:.92';
      table.appendChild(cell);
    }

    for (const row of visibleRows()) {
      const resources = row.banked || {};
      const cells = [
        String(row.rank || ''),
        shortId(row.ownerActor),
        formatNumber(row.score || 0),
        `${resources.scrst || 0}/${resources.bcrst || 0}/${resources.hcrst || 0}`,
        formatNumber(row.moves || 0),
      ];
      for (let i = 0; i < cells.length; i += 1) {
        const cell = document.createElement('div');
        cell.textContent = cells[i];
        cell.title = i === 1 ? row.ownerActor : '';
        cell.style.cssText = `padding:8px;border-bottom:1px solid rgba(255,255,255,.08);
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${i === 2 ? '#7CFFB0' : '#fff'}`;
        table.appendChild(cell);
      }
    }
    body.appendChild(table);

    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;flex-wrap:wrap';
    const page = document.createElement('div');
    page.style.cssText = 'font-size:11px;color:#cdd3da;opacity:.82';
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
      state.rows = await fetchLeaderboard({ metric: 'banked', limit });
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
    btn.style.cssText = btnCss(disabled ? '#555' : '#cdd3da') + 'font-size:18px;padding:4px 11px;min-width:38px';
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

  render();
  refresh();

  return {
    element: root,
    refresh,
    destroy() {
      state.destroyed = true;
      root.remove();
    },
  };
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 18) return text || '-';
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}
