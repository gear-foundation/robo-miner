import Phaser from 'phaser';
import { CHAIN, redeemReady } from '../chain/config.js';
import { RESOURCES, RedeemClient, formatVara, payoutFor } from '../chain/redeem.js';
import { connectWallet as connectBrowserWallet, startWalletDiscovery, subscribeWallet } from '../chain/wallet.js';
import { btnCss, wireBtn } from './arenaUI.js';
import { navigateBack } from '../router.js';

export default class RedeemScene extends Phaser.Scene {
  constructor() { super('Redeem'); }

  init(data = {}) {
    this.backTo = data.backTo || 'Landing';
  }

  create() {
    this.cleanupDOM();
    startWalletDiscovery();
    const W = this.scale.width;
    const H = this.scale.height;
    this.add.graphics().fillStyle(0x1e140b, 1).fillRect(0, 0, W, H);
    this.client = new RedeemClient();
    this.amounts = { scrst: '0', bcrst: '0', hcrst: '0' };
    this.state = null;
    this.busy = false;
    this.status = '';
    this.buildDOM();
    this.unsubscribeWallet = subscribeWallet((state) => this.onWalletState(state));
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy', () => this.destroyDOM());
  }

  onResize() { this.scene.restart(); }

  buildDOM() {
    const root = document.createElement('div');
    root.id = 'redeem-page';
    root.style.cssText = `position:fixed;inset:0;z-index:20;overflow:auto;
      background:linear-gradient(#5f95c8 0 26%, #3f7b36 26% 28%, #25160b 28% 100%);
      font-family:'Courier New',monospace;color:#fff;padding:28px 18px 58px;box-sizing:border-box`;

    const back = wireBtn(document.createElement('button'));
    back.textContent = '← BACK';
    back.style.cssText = btnCss('#cdd3da') + 'position:fixed;left:18px;top:18px;min-width:120px;font-size:16px;padding:10px 18px;z-index:21';
    back.onclick = () => this.goMenu();
    root.appendChild(back);

    const title = document.createElement('header');
    title.style.cssText = 'text-align:center;margin:8px 0 22px';
    title.innerHTML = `
      <div style="font-size:42px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000">RES REDEEM</div>
      <div style="margin-top:4px;font-size:16px;color:#fff;text-shadow:2px 2px 0 #000">SCRST × 6 · BCRST × 30 · HCRST × 150</div>
    `;
    root.appendChild(title);

    const panel = document.createElement('main');
    panel.style.cssText = `max-width:980px;margin:0 auto;background:#120c07;
      border:4px solid #000;box-shadow:5px 5px 0 rgba(0,0,0,.45);
      border-radius:8px;padding:18px;box-sizing:border-box`;

    const top = document.createElement('section');
    top.style.cssText = 'display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px';
    this.walletText = document.createElement('div');
    this.walletText.style.cssText = 'font-size:14px;color:#cdd3da;overflow-wrap:anywhere';
    const connect = wireBtn(document.createElement('button'));
    connect.textContent = 'CONNECT WALLET';
    connect.style.cssText = btnCss('#ffdd55') + 'font-size:16px;padding:11px 18px;min-width:190px';
    connect.onclick = () => this.changeWallet();
    this.connectBtn = connect;
    top.append(this.walletText, connect);
    panel.appendChild(top);

    this.warningEl = document.createElement('div');
    this.warningEl.style.cssText = 'display:none;margin-bottom:14px;padding:11px 12px;background:#3a1d1d;border:2px solid #ff6a6a;color:#ffd4d4;border-radius:6px;font-size:14px';
    panel.appendChild(this.warningEl);

    const balanceWrap = document.createElement('section');
    balanceWrap.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px';
    this.balanceEls = {};
    for (const res of RESOURCES) {
      const cell = document.createElement('div');
      cell.style.cssText = `border:3px solid #000;background:#24160c;border-radius:8px;padding:12px;
        box-shadow:3px 3px 0 rgba(0,0,0,.35);min-height:74px`;
      cell.innerHTML = `
        <div style="font-size:13px;color:${res.color};font-weight:bold">${res.label}</div>
        <div data-balance="${res.key}" style="font-size:28px;color:#fff;font-weight:bold;margin-top:6px">0</div>
      `;
      this.balanceEls[res.key] = cell.querySelector(`[data-balance="${res.key}"]`);
      balanceWrap.appendChild(cell);
    }
    panel.appendChild(balanceWrap);

    const form = document.createElement('section');
    form.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:16px';
    this.inputs = {};
    for (const res of RESOURCES) {
      const label = document.createElement('label');
      label.style.cssText = `display:block;border:3px solid #000;background:#1a1109;border-radius:8px;
        padding:12px;box-shadow:3px 3px 0 rgba(0,0,0,.35)`;
      label.innerHTML = `
        <span style="display:block;font-size:13px;color:${res.color};font-weight:bold;margin-bottom:8px">${res.label}</span>
        <input data-input="${res.key}" inputmode="numeric" min="0" step="1" value="0"
          style="width:100%;box-sizing:border-box;background:#fff;color:#111;border:3px solid #000;border-radius:6px;
          font-family:'Courier New',monospace;font-size:22px;font-weight:bold;padding:8px 10px" />
      `;
      const input = label.querySelector('input');
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D+/g, '').replace(/^0+(?=\d)/, '') || '0';
        this.amounts[res.key] = input.value;
        this.render();
      });
      this.inputs[res.key] = input;
      form.appendChild(label);
    }
    panel.appendChild(form);

    const bottom = document.createElement('section');
    bottom.style.cssText = 'display:flex;gap:14px;align-items:stretch;justify-content:space-between;flex-wrap:wrap';
    const quote = document.createElement('div');
    quote.style.cssText = 'flex:1 1 280px;border:3px solid #000;background:#261a0f;border-radius:8px;padding:12px;min-height:72px';
    quote.innerHTML = `
      <div style="font-size:13px;color:#cdd3da;font-weight:bold">PAYOUT</div>
      <div id="redeem-payout" style="font-size:30px;color:#7CFFB0;font-weight:bold;margin-top:6px">0 VARA</div>
    `;
    this.payoutEl = quote.querySelector('#redeem-payout');
    const submit = wireBtn(document.createElement('button'));
    submit.textContent = 'REDEEM';
    submit.style.cssText = btnCss('#7CFFB0') + 'flex:0 0 220px;font-size:20px;padding:16px 22px';
    submit.onclick = () => this.submitRedeem();
    this.submitBtn = submit;
    bottom.append(quote, submit);
    panel.appendChild(bottom);

    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'margin-top:14px;min-height:24px;font-size:14px;color:#cdd3da;overflow-wrap:anywhere';
    panel.appendChild(this.statusEl);

    root.appendChild(panel);
    document.body.appendChild(root);
    this.rootEl = root;
    this.render();
  }

  async changeWallet() {
    await this.runBusy('Connecting wallet...', async () => {
      const walletState = await connectBrowserWallet({ forceSelection: true });
      await this.client.attachWallet(walletState);
      this.status = 'Wallet connected.';
      try {
        await this.refresh();
      } catch (error) {
        this.status = `Wallet connected, but balance read failed: ${error?.message || String(error)}`;
      }
    });
  }

  async attachConnectedWallet(walletState) {
    try {
      await this.client.attachWallet(walletState);
      await this.refresh();
    } catch {
      this.render();
    }
  }

  onWalletState(walletState) {
    if (!this.rootEl) return;
    const nextAccount = walletState.account || null;
    if (nextAccount && nextAccount !== this.client.account) {
      this.state = null;
      this.attachConnectedWallet(walletState);
      return;
    }
    if (!nextAccount) {
      this.state = null;
      this.client.account = null;
      this.render();
    }
  }

  async refresh() {
    this.state = await this.client.readAccountState();
    this.render();
  }

  async submitRedeem() {
    await this.runBusy('Waiting for wallet signature...', async () => {
      const validation = this.validateForm();
      if (validation) throw new Error(validation);
      const result = await this.client.redeem(this.amounts);
      this.status = `Redeem sent: ${shortHash(result.txHash || result.messageId || '')}`;
      await this.refresh();
    }, (error) => {
      const msg = error?.message || String(error);
      this.status = msg.includes('insufficient')
        ? 'Redeem failed: not enough RES for this amount.'
        : msg.includes('paused')
          ? 'Redeem is paused.'
          : `Redeem failed: ${msg}`;
    });
  }

  async runBusy(label, fn, onError = null) {
    this.busy = true;
    this.status = label;
    this.render();
    try {
      await fn();
    } catch (error) {
      if (onError) onError(error);
      else this.status = error?.message || String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  validateForm() {
    if (!redeemReady()) return 'Redeem contracts are not configured.';
    if (!this.state) return 'Connect wallet first.';
    if (this.state.paused) return 'Redeem is paused.';
    const amounts = this.readAmounts();
    if (amounts.scrst + amounts.bcrst + amounts.hcrst === 0n) return 'Enter at least one RES amount.';
    for (const res of RESOURCES) {
      if (amounts[res.key] > (this.state.balances[res.key] || 0n)) return `Not enough ${res.label}.`;
    }
    const quote = payoutFor(amounts, this.state.rates, this.state.varaUnit);
    if (quote.raw > this.state.reserve) return 'Reserve is not enough for this redeem.';
    return null;
  }

  readAmounts() {
    return Object.fromEntries(RESOURCES.map((res) => [res.key, BigInt(this.inputs?.[res.key]?.value || '0')]));
  }

  render() {
    const configured = redeemReady();
    this.walletText.textContent = this.client?.account
      ? `Wallet ${shortHash(this.client.account)}`
      : configured ? 'Wallet not connected' : 'Redeem contracts not configured';
    this.connectBtn.textContent = this.client?.account ? 'CHANGE WALLET' : 'CONNECT WALLET';
    this.connectBtn.disabled = this.busy || !configured;
    this.connectBtn.style.opacity = this.connectBtn.disabled ? '0.55' : '1';

    const balances = this.state?.balances || {};
    for (const res of RESOURCES) {
      if (this.balanceEls[res.key]) this.balanceEls[res.key].textContent = String(balances[res.key] || 0n);
    }

    let quote = { raw: 0n, display: '0 VARA' };
    try {
      quote = this.state ? payoutFor(this.readAmounts(), this.state.rates, this.state.varaUnit) : quote;
    } catch {
      quote = { raw: 0n, display: '0 VARA' };
    }
    this.payoutEl.textContent = quote.display;

    const validation = this.validateForm();
    this.submitBtn.disabled = this.busy || Boolean(validation);
    this.submitBtn.style.opacity = this.submitBtn.disabled ? '0.55' : '1';
    this.warningEl.style.display = validation && this.state ? 'block' : 'none';
    this.warningEl.textContent = validation || '';
    this.statusEl.textContent = this.status || '';
  }

  goMenu() {
    this.scale.off('resize', this.onResize, this);
    navigateBack(this, this.backTo || 'Landing');
  }

  cleanupDOM() {
    document.getElementById('redeem-page')?.remove();
  }

  destroyDOM() {
    this.unsubscribeWallet?.();
    this.unsubscribeWallet = null;
    this.cleanupDOM();
  }
}

function shortHash(value) {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text;
}
