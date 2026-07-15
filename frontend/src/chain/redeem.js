import { CHAIN, discoveryUrl, redeemReady } from './config.js';
import { getWalletState } from './wallet.js';

const RESOURCES = [
  { key: 'scrst', label: 'SCRST', id: '0', color: '#ffe066' },
  { key: 'bcrst', label: 'BCRST', id: '1', color: '#7CFFB0' },
  { key: 'hcrst', label: 'HCRST', id: '2', color: '#5fd0e6' },
];

const VARA_FALLBACK_UNIT = 1_000_000_000_000n;

export class RedeemClient {
  constructor(config = CHAIN) {
    this.config = config;
    this.api = null;
    this.publicClient = null;
    this.walletClient = null;
    this.signer = null;
    this.account = null;
    this.resProgram = null;
    this.backendConfig = null;
  }

  ready() {
    return redeemReady();
  }

  async attachWallet(walletState = getWalletState()) {
    const selectedProvider = walletState?.provider;
    const selectedAccount = walletState?.account;
    if (!selectedProvider?.request || !selectedAccount) throw new Error('Connect wallet first.');
    const { custom } = await import('viem');
    const { walletClientToSigner } = await import('@vara-eth/api/signer');
    await this.ensureBase();
    const { createWalletClient } = await import('viem');
    this.account = normalizeAddress(selectedAccount);
    this.walletClient = createWalletClient({
      account: { address: this.account, type: 'json-rpc' },
      transport: custom(selectedProvider),
    });
    this.signer = walletClientToSigner(this.walletClient);
    await this.ensureApi();
    return this.account;
  }

  async readAccountState(account = this.account) {
    if (!account) throw new Error('Connect wallet first.');
    assertRedeemConfig(this.config);
    await this.ensureApi();
    await this.ensurePrograms();
    const ownerActor = actorIdFromAddress(account);
    const vmt = this.resProgram.services.Vmt.queries;
    const [scrst, bcrst, hcrst, backend] = await Promise.all([
      this.query('VMT.BalanceOf SCRST', this.config.resVmtProgramId, vmt.BalanceOf, ownerActor, '0').then(toBigIntResult),
      this.query('VMT.BalanceOf BCRST', this.config.resVmtProgramId, vmt.BalanceOf, ownerActor, '1').then(toBigIntResult),
      this.query('VMT.BalanceOf HCRST', this.config.resVmtProgramId, vmt.BalanceOf, ownerActor, '2').then(toBigIntResult),
      this.fetchBackendConfig(),
    ]);

    return {
      account: normalizeAddress(account),
      ownerActor,
      balances: { scrst, bcrst, hcrst },
      rates: Object.fromEntries(Object.entries(backend.rates).map(([key, value]) => [key, BigInt(value)])),
      varaUnit: BigInt(backend.varaUnit || VARA_FALLBACK_UNIT),
      paused: !backend.enabled,
    };
  }

  async redeem(amounts) {
    if (!this.account || !this.walletClient) throw new Error('Connect wallet first.');
    assertRedeemConfig(this.config);
    const scrst = toBigIntAmount(amounts.scrst);
    const bcrst = toBigIntAmount(amounts.bcrst);
    const hcrst = toBigIntAmount(amounts.hcrst);
    if (scrst + bcrst + hcrst === 0n) throw new Error('Enter at least one RES amount.');

    const backend = await this.fetchBackendConfig(true);
    if (!backend.enabled) throw new Error('Redeem is temporarily unavailable.');
    const minPayout = payoutFor(
      { scrst, bcrst, hcrst },
      backend.rates,
      BigInt(backend.varaUnit || VARA_FALLBACK_UNIT),
    ).raw;
    const nonce = randomBytes32();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.min(300, Math.floor(backend.requestTtlMs / 1000)));
    const message = { owner: this.account, scrst, bcrst, hcrst, minPayout, nonce, deadline };
    const signature = await this.walletClient.signTypedData({
      account: this.account,
      domain: backend.domain,
      types: backend.types,
      primaryType: backend.primaryType,
      message,
    });
    const queued = await backendFetch('/api/redeem/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: this.account,
        scrst: scrst.toString(),
        bcrst: bcrst.toString(),
        hcrst: hcrst.toString(),
        minPayout: minPayout.toString(),
        nonce,
        deadline: deadline.toString(),
        signature,
      }),
    });
    return this.waitForRequest(queued.requestId);
  }

  async ensureBase() {
    if (this.publicClient) return;
    if (!this.ready()) throw new Error('Redeem contracts are not configured.');
    const { Buffer } = await import('buffer');
    globalThis.Buffer ||= Buffer;
    const { createPublicClient, http, webSocket } = await import('viem');
    this.publicClient = createPublicClient({ transport: transportFor(this.config.ethRpc, { http, webSocket }) });
  }

  async ensureApi() {
    await this.ensureBase();
    if (this.api) return;
    const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
    this.api = await createVaraEthApi(
      new WsVaraEthProvider(this.config.varaEthWs),
      this.publicClient,
      this.config.routerAddress,
      this.signer,
    );
  }

  async ensurePrograms() {
    if (this.resProgram) return;
    const { SailsProgram } = await import('sails-js');
    const { SailsIdlParser } = await import('sails-js/parser');
    const parser = new SailsIdlParser();
    await parser.init();
    const resIdl = await fetch(new URL('./digger_res_vmt.idl', import.meta.url)).then((r) => r.text());
    this.resProgram = new SailsProgram(parser.parse(resIdl));
    this.resProgram.setProgramId(this.config.resVmtProgramId);
  }

  async fetchBackendConfig(force = false) {
    if (this.backendConfig && !force) return this.backendConfig;
    this.backendConfig = await backendFetch('/api/redeem/config');
    return this.backendConfig;
  }

  async waitForRequest(requestId, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await backendFetch(`/api/redeem/requests/${encodeURIComponent(requestId)}`);
      if (record.status === 'confirmed') return record;
      if (['failed', 'canceled'].includes(record.status)) throw new Error(record.error || `Redeem ${record.status}.`);
      await sleep(2_000);
    }
    throw new Error(`Redeem is still processing. Request: ${requestId}`);
  }

  async query(label, programId, query, ...args) {
    try {
      if (!isAddress(programId)) throw new Error(`Invalid program id: ${programId || '(empty)'}`);
      const payload = query.encodePayload(...args);
      const response = await this.api.provider.send('program_calculateReplyForHandle', [
        null,
        this.account || '0x0000000000000000000000000000000000000000',
        programId,
        payload,
        0n,
      ]);
      const reply = response.reply || response;
      if (!isSuccessReplyCode(reply.code)) {
        throw new Error(`contract replied ${reply.code || 'error'} ${reply.payload || ''}`.trim());
      }
      if (!reply.payload) {
        throw new Error(`no payload from ${programId}`);
      }
      return query.decodeResult(reply.payload);
    } catch (error) {
      throw new Error(`${label} failed: ${error?.message || String(error)}`);
    }
  }
}

export { RESOURCES };

export function payoutFor(amounts, rates, varaUnit = VARA_FALLBACK_UNIT) {
  const displayAmount = (
    toBigIntAmount(amounts.scrst) * BigInt(rates.scrst || 0n)
    + toBigIntAmount(amounts.bcrst) * BigInt(rates.bcrst || 0n)
    + toBigIntAmount(amounts.hcrst) * BigInt(rates.hcrst || 0n)
  );
  const raw = displayAmount * BigInt(varaUnit || VARA_FALLBACK_UNIT);
  return { raw, display: formatVara(raw, varaUnit) };
}

export function formatVara(value, unit = VARA_FALLBACK_UNIT) {
  const raw = BigInt(value || 0n);
  const decimals = decimalPlaces(unit);
  const whole = raw / unit;
  const frac = raw % unit;
  if (frac === 0n) return `${whole.toString()} WVARA`;
  const fracText = frac.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);
  return `${whole.toString()}.${fracText || '0'} WVARA`;
}

export function actorIdFromAddress(address) {
  const normalized = normalizeAddress(address);
  return `0x${'00'.repeat(12)}${normalized.slice(2)}`;
}

function toBigIntAmount(value) {
  const text = String(value ?? '0').trim();
  if (!text) return 0n;
  if (!/^\d+$/.test(text)) throw new Error('RES amounts must be whole numbers.');
  return BigInt(text);
}

function toBigIntResult(value) {
  return typeof value === 'bigint' ? value : BigInt(String(value ?? 0));
}

function isSuccessReplyCode(code) {
  if (!code) return false;
  if (typeof code === 'string') return code === '0x00000000' || code === '0x00010000';
  return Boolean(code.isSuccess);
}

function decimalPlaces(unit) {
  const text = BigInt(unit || VARA_FALLBACK_UNIT).toString();
  return text.length - 1;
}

function normalizeAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(text)) throw new Error(`Invalid wallet address: ${value}`);
  return text;
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || '').trim());
}

function assertRedeemConfig(config) {
  if (!config.enabled) throw new Error('Chain mode is disabled. Set VITE_CHAIN_ENABLED=true.');
  if (!isAddress(config.resVmtProgramId)) throw new Error('VITE_RES_VMT_PROGRAM_ID is missing or invalid.');
  if (!isAddress(config.routerAddress)) throw new Error('VITE_ROUTER_ADDRESS is missing or invalid.');
  if (!config.ethRpc || !config.varaEthWs) throw new Error('Vara.eth RPC config is missing.');
}

async function backendFetch(path, options = {}) {
  const response = await fetch(discoveryUrl(path), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Backend request failed (${response.status}).`);
  return payload;
}

function randomBytes32() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportFor(url, viem) {
  return String(url || '').startsWith('ws') ? viem.webSocket(url) : viem.http(url);
}
