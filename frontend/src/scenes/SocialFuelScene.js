import Phaser from 'phaser';
import { backendEnabled, fetchSocialXSubmissions, submitSocialXTask } from '../backend/api.js';
import { connectWallet as connectBrowserWallet, getWalletState, startWalletDiscovery, subscribeWallet } from '../chain/wallet.js';
import { btnCss, wireBtn } from './arenaUI.js';
import { navigateBack } from '../router.js';

export default class SocialFuelScene extends Phaser.Scene {
  constructor() { super('SocialFuel'); }

  init(data = {}) {
    this.backTo = data.backTo || 'Menu';
  }

  create() {
    this.cleanupDOM();
    startWalletDiscovery();
    this.add.graphics().fillStyle(0x111015, 1).fillRect(0, 0, this.scale.width, this.scale.height);
    this.account = getWalletState().account || '';
    this.taskType = 'repost';
    this.busy = false;
    this.status = '';
    this.submissions = [];
    this.buildDOM();
    this.unsubscribeWallet = subscribeWallet((state) => {
      const previous = this.account;
      this.account = state.account || '';
      this.render();
      if (this.account && this.account !== previous) this.loadHistory({ silent: true });
    });
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy', () => this.destroyDOM());
  }

  onResize() { this.scene.restart({ backTo: this.backTo }); }

  buildDOM() {
    const narrow = this.scale.width < 860;
    const root = document.createElement('div');
    root.id = 'social-fuel-page';
    root.style.cssText = `position:fixed;inset:0;z-index:20;overflow:auto;
      background:
        radial-gradient(circle at 18% 18%, rgba(124,255,176,.22), transparent 28%),
        radial-gradient(circle at 84% 0%, rgba(255,221,85,.22), transparent 26%),
        linear-gradient(180deg, #16171d 0%, #0b0e12 54%, #17100a 100%);
      font-family:'Courier New',monospace;color:#f8fbff;padding:28px 18px 64px;box-sizing:border-box`;

    const back = wireBtn(document.createElement('button'));
    back.textContent = '< BACK';
    back.style.cssText = btnCss('#cdd3da') + 'position:fixed;left:18px;top:18px;min-width:118px;font-size:16px;padding:10px 18px;z-index:21';
    back.onclick = () => this.goBack();
    root.appendChild(back);

    const header = document.createElement('header');
    header.style.cssText = 'max-width:1080px;margin:0 auto 22px;padding-top:28px;text-align:center';
    header.innerHTML = `
      <div style="display:inline-block;background:#7CFFB0;color:#07150d;border:3px solid #000;
        box-shadow:3px 3px 0 rgba(0,0,0,.45);padding:8px 14px;font-size:13px;font-weight:bold">
        SOCIAL VERIFIER
      </div>
      <h1 style="margin:18px 0 8px;font-size:clamp(36px,6vw,72px);line-height:1;color:#ffdd55;
        text-shadow:4px 4px 0 #000;letter-spacing:0">Free wVARA fuel</h1>
      <p style="margin:0 auto;max-width:760px;color:#d8e2ed;font-size:18px;line-height:1.55">
        Repost or quote the campaign post, submit the X link, and the backend verifies it before topping up your active digger fuel.
      </p>
    `;
    root.appendChild(header);

    const panel = document.createElement('main');
    panel.style.cssText = `max-width:1080px;margin:0 auto;display:grid;grid-template-columns:${narrow ? '1fr' : 'minmax(0,1.05fr) minmax(320px,.95fr)'};
      gap:16px;align-items:start`;

    const form = document.createElement('section');
    form.style.cssText = cardCss('#101820');
    form.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <div style="font-size:13px;color:#9db0bf;font-weight:bold">WALLET</div>
          <div id="social-wallet" style="margin-top:5px;color:#fff;font-size:15px;overflow-wrap:anywhere">Not connected</div>
        </div>
        <button id="social-connect" type="button" style="${btnCss('#ffdd55')}font-size:15px;padding:11px 16px;min-width:180px">CONNECT</button>
      </div>

      <div style="display:grid;grid-template-columns:${narrow ? '1fr' : '1fr 1fr'};gap:10px;margin-bottom:14px">
        <button data-task="repost" type="button" class="social-task-btn">Repost<br><span>60 wVARA fuel</span></button>
        <button data-task="quote" type="button" class="social-task-btn">Quote<br><span>120 wVARA fuel</span></button>
      </div>

      <label style="${labelCss()}">
        <span>X username</span>
        <input id="social-x-username" placeholder="@username" autocomplete="off" />
      </label>
      <label style="${labelCss()}">
        <span>Post URL</span>
        <input id="social-tweet-url" placeholder="https://x.com/.../status/..." autocomplete="off" />
      </label>
      <label style="${labelCss()}">
        <span>Digger program id, optional</span>
        <input id="social-digger-id" placeholder="Uses your active digger automatically" autocomplete="off" />
      </label>

      <button id="social-submit" type="button" style="${btnCss('#7CFFB0')}width:100%;font-size:18px;padding:15px 18px;margin-top:4px">VERIFY AND FUEL</button>
      <div id="social-status" style="min-height:24px;margin-top:14px;color:#d8e2ed;font-size:14px;overflow-wrap:anywhere"></div>
    `;
    panel.appendChild(form);

    const explainer = document.createElement('aside');
    explainer.style.cssText = cardCss('#141017');
    explainer.innerHTML = `
      <h2 style="${panelTitleCss()}">How the verifier works</h2>
      <div style="display:grid;gap:10px;margin-top:12px">
        ${step('01', 'Submit', 'Wallet, X username, and a repost or quote URL are sent to the backend.')}
        ${step('02', 'Verify', 'The backend checks X API data, source account, author, and campaign text.')}
        ${step('03', 'Protect', 'One wallet and one X account can claim each task only once per week.')}
        ${step('04', 'Fuel', 'Approved claims create an audited social-x fuel grant for the active digger.')}
      </div>
    `;
    panel.appendChild(explainer);

    const history = document.createElement('section');
    history.style.cssText = `${cardCss('#0f151b')}grid-column:1 / -1;margin-top:0;overflow:hidden`;
    history.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
        <h2 style="${panelTitleCss()}">My social claims</h2>
        <button id="social-refresh" type="button" style="${btnCss('#bff3ff')}font-size:14px;padding:9px 14px">REFRESH</button>
      </div>
      <div id="social-history" style="margin-top:12px;display:grid;gap:8px"></div>
    `;
    panel.appendChild(history);

    root.appendChild(panel);
    document.body.appendChild(root);
    this.rootEl = root;
    this.walletEl = root.querySelector('#social-wallet');
    this.connectBtn = root.querySelector('#social-connect');
    this.submitBtn = root.querySelector('#social-submit');
    this.statusEl = root.querySelector('#social-status');
    this.historyEl = root.querySelector('#social-history');
    this.usernameInput = root.querySelector('#social-x-username');
    this.tweetInput = root.querySelector('#social-tweet-url');
    this.diggerInput = root.querySelector('#social-digger-id');
    this.taskButtons = Array.from(root.querySelectorAll('[data-task]'));
    root.querySelectorAll('input').forEach((input) => {
      input.style.cssText = `width:100%;box-sizing:border-box;margin-top:7px;background:#fff;color:#111;
        border:3px solid #000;border-radius:8px;font-family:'Courier New',monospace;
        font-size:16px;font-weight:bold;padding:11px 12px;outline:none`;
    });

    root.querySelectorAll('.social-task-btn').forEach((btn) => {
      btn.style.cssText = `${btnCss('#1d2730')}color:#f8fbff;font-size:16px;padding:13px 10px;line-height:1.25`;
      btn.querySelector('span').style.cssText = 'font-size:12px;color:#9db0bf';
      btn.onclick = () => {
        this.taskType = btn.dataset.task;
        this.render();
      };
    });
    this.connectBtn.onclick = () => this.changeWallet();
    this.submitBtn.onclick = () => this.submit();
    root.querySelector('#social-refresh').onclick = () => this.loadHistory();
    this.render();
  }

  async changeWallet() {
    await this.runBusy('Connecting wallet...', async () => {
      const state = await connectBrowserWallet({ forceSelection: true });
      this.account = state.account;
      if (!this.account) throw new Error('Wallet account was not returned.');
      this.status = 'Wallet connected.';
      await this.loadHistory({ silent: true });
    });
  }

  async submit() {
    await this.runBusy('Verifying X task...', async () => {
      if (!backendEnabled()) throw new Error('Backend URL is not configured.');
      if (!this.account) throw new Error('Connect wallet first.');
      const tweetUrl = this.tweetInput.value.trim();
      if (!tweetUrl) throw new Error('Paste the X post URL.');
      const result = await submitSocialXTask({
        owner: this.account,
        taskType: this.taskType,
        tweetUrl,
        xUsername: this.usernameInput.value.trim(),
        diggerProgramId: this.diggerInput.value.trim() || null,
      });
      this.status = `${result.status}: ${formatVara(result.amount)} wVARA fuel grant for ${shortHash(result.programId)}.`;
      this.tweetInput.value = '';
      await this.loadHistory();
    });
  }

  async loadHistory(options = {}) {
    if (!backendEnabled()) {
      this.submissions = [];
      this.status = 'Backend URL is not configured.';
      this.render();
      return;
    }
    if (!this.account) {
      this.submissions = [];
      this.render();
      return;
    }
    try {
      this.submissions = await fetchSocialXSubmissions({ owner: this.account, limit: 20 });
      this.render();
    } catch (error) {
      this.submissions = [];
      if (!options.silent) this.status = error?.message || String(error);
      this.render();
    }
  }

  async runBusy(label, fn) {
    this.busy = true;
    this.status = label;
    this.render();
    try {
      await fn();
    } catch (error) {
      this.status = explainError(error?.message || String(error));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    if (!this.rootEl) return;
    this.walletEl.textContent = this.account ? shortHash(this.account) : 'Not connected';
    this.connectBtn.textContent = this.account ? 'CHANGE' : 'CONNECT';
    this.connectBtn.disabled = this.busy;
    this.submitBtn.disabled = this.busy || !backendEnabled();
    this.connectBtn.style.opacity = this.connectBtn.disabled ? '0.55' : '1';
    this.submitBtn.style.opacity = this.submitBtn.disabled ? '0.55' : '1';
    this.statusEl.textContent = this.status || (!backendEnabled() ? 'Backend URL is not configured.' : '');

    for (const btn of this.taskButtons) {
      const selected = btn.dataset.task === this.taskType;
      btn.style.background = selected ? '#7CFFB0' : '#1d2730';
      btn.style.color = selected ? '#07150d' : '#f8fbff';
      btn.style.transform = 'scale(1)';
    }

    this.historyEl.innerHTML = this.submissions.length
      ? this.submissions.map((item) => historyRow(item, this.scale.width < 720)).join('')
      : `<div style="color:#9db0bf;border:2px dashed #33414c;padding:13px;border-radius:8px">No social claims for this wallet yet.</div>`;
  }

  goBack() {
    this.scale.off('resize', this.onResize, this);
    navigateBack(this, this.backTo || 'Menu');
  }

  cleanupDOM() {
    document.getElementById('social-fuel-page')?.remove();
  }

  destroyDOM() {
    this.unsubscribeWallet?.();
    this.unsubscribeWallet = null;
    this.cleanupDOM();
  }
}

function cardCss(bg) {
  return `background:${bg};border:4px solid #000;box-shadow:5px 5px 0 rgba(0,0,0,.45);
    border-radius:8px;padding:18px;box-sizing:border-box`;
}

function labelCss() {
  return `display:block;margin-bottom:12px;color:#9db0bf;font-size:13px;font-weight:bold`;
}

function panelTitleCss() {
  return 'margin:0;color:#ffdd55;font-size:24px;text-shadow:2px 2px 0 #000';
}

function step(number, title, text) {
  return `
    <div style="display:grid;grid-template-columns:44px 1fr;gap:11px;align-items:start;border:2px solid #26333f;background:#0c1117;border-radius:8px;padding:11px">
      <b style="color:#7CFFB0;font-size:18px">${number}</b>
      <div><strong style="color:#fff">${title}</strong><p style="margin:4px 0 0;color:#c8d3dd;line-height:1.45">${text}</p></div>
    </div>
  `;
}

function historyRow(item, narrow = false) {
  return `
    <div style="display:grid;grid-template-columns:${narrow ? '1fr' : '120px 1fr 150px'};gap:10px;align-items:center;border:2px solid #26333f;background:#0b1016;border-radius:8px;padding:11px">
      <b style="color:#7CFFB0">${escapeHtml(item.taskType || 'task')}</b>
      <span style="color:#d8e2ed;overflow-wrap:anywhere">${escapeHtml(shortHash(item.tweetUrl || item.tweetId || ''))}</span>
      <span style="color:#ffdd55;text-align:${narrow ? 'left' : 'right'}">${escapeHtml(item.status || '')}</span>
    </div>
  `;
}

function formatVara(planck) {
  const value = BigInt(planck || 0);
  return (value / 1_000_000_000_000n).toString();
}

function shortHash(value) {
  const text = String(value || '');
  return text.length > 24 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

function explainError(message) {
  const known = {
    wallet_connection_timeout: 'Wallet did not answer. Open MetaMask, unlock it, and try Connect again.',
    wallet_request_already_pending: 'MetaMask already has a pending connection request. Open the extension window and approve or reject it.',
    wallet_request_rejected: 'Wallet connection was rejected.',
    'Wallet was not selected.': 'Wallet selection was closed.',
    wallet_already_paid_for_task_this_week: 'This wallet already claimed this task this week.',
    x_account_already_paid_this_week: 'This X account already claimed this task this week.',
    x_post_already_paid_for_task: 'This X post was already used for this task.',
    active_digger_not_found_for_owner: 'No active digger was found for this wallet.',
    x_bearer_token_missing: 'X API token is missing on the backend.',
    tweet_url_invalid: 'The X post URL is invalid.',
    tweet_url_must_point_to_x: 'Use an x.com or twitter.com post URL.',
    tweet_url_missing_status_id: 'The X URL must point to a concrete status post.',
  };
  return known[message] || message;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
