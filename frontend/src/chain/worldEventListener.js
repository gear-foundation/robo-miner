import { CHAIN } from './config.js';
import { decodeWorldEvent, worldActions, worldQueries } from './world.js';

const SUBSCRIBE_METHOD = 'program_subscribeBestState';
const UNSUBSCRIBE_METHOD = 'program_unsubscribeBestState';
const RECONNECT_MS = 1500;
const SUBSCRIPTION_ACK_MS = 8000;
const READ_SOURCE = '0x0000000000000000000000000000000000000001';

export function isVaraEthConnectionError(error) {
  return /websocket (is )?(disconnected|connection (closed|failed))|call connect\(\)|failed to connect to websocket/i
    .test(String(error?.message || error || ''));
}

export async function ensureVaraEthProviderConnected(provider) {
  if (!provider || typeof provider.connect !== 'function') {
    throw new Error('Vara.eth WebSocket provider is unavailable');
  }
  if (provider.isConnected === true || provider.connectionState === 'connected') return;
  await provider.connect();
}

export async function calculateWorldReply({ api, provider, source, programId, payload }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureVaraEthProviderConnected(provider);
    try {
      return await api.call.program.calculateReplyForHandle(source, programId, payload);
    } catch (error) {
      if (attempt === 0 && isVaraEthConnectionError(error)) continue;
      throw error;
    }
  }
  throw new Error('Vara.eth query retry exhausted');
}

function bytesToHex(bytes) {
  if (!bytes) return '';
  if (typeof bytes === 'string') return bytes;
  if (Array.isArray(bytes)) {
    return `0x${bytes.map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
  }
  if (ArrayBuffer.isView(bytes)) {
    return `0x${Array.from(bytes).map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof bytes === 'object' && bytes.bytes) return bytesToHex(bytes.bytes);
  return '';
}

function messagePayload(message) {
  return message?.payload
    || message?.data?.payload
    || message?.reply?.payload
    || message?.details?.payload
    || null;
}

function messageDestination(message) {
  return message?.destination
    || message?.data?.destination
    || message?.details?.destination
    || null;
}

function destinationHex(destination) {
  if (!destination) return '';
  if (typeof destination === 'string') return destination.toLowerCase();
  if (typeof destination?.toHex === 'function') return destination.toHex().toLowerCase();
  if (typeof destination?.toString === 'function') {
    const text = destination.toString();
    if (text.startsWith('0x')) return text.toLowerCase();
  }
  return bytesToHex(destination).toLowerCase();
}

function isZeroDestination(destination) {
  const hex = destinationHex(destination);
  if (!hex) return true;
  const bytes = hex.startsWith('0x') ? hex.slice(2) : hex;
  return /^0+$/.test(bytes);
}

function notificationResult(message) {
  if (!message || !message.method) return null;
  return message.params?.result || message.result || null;
}

function rpcErrorMessage(error) {
  if (!error) return 'unknown RPC error';
  if (error.code === -32601) return `${SUBSCRIBE_METHOD} is not available on this Vara.eth RPC yet`;
  return error.message || JSON.stringify(error);
}

function bestStateMbHash(bestState) {
  return bestState?.mbHash || bestState?.mb_hash || '';
}

function bestStateNewHash(bestState) {
  return bestState?.newStateHash || bestState?.new_state_hash || '';
}

function decodeProgramEvent(program, payload) {
  for (const [serviceName, service] of Object.entries(program?.services || {})) {
    for (const [eventName, event] of Object.entries(service?.events || {})) {
      try {
        return { service: serviceName, event: eventName, data: event.decode(payload) };
      } catch {
        // Best-state messages also include replies/calls; only event payloads
        // match one of the Sails event headers.
      }
    }
  }
  return null;
}

export async function connectWorldProgram({ programId, idlUrl, config = CHAIN }) {
  const { Buffer } = await import('buffer');
  globalThis.Buffer ||= Buffer;
  const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
  const { createPublicClient, http } = await import('viem');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');

  // Do not rely on the SDK's fire-and-forget auto-connect. createVaraEthApi()
  // initializes the Ethereum client, not this provider, so a first read could
  // otherwise race a disconnected WebSocket.
  const provider = new WsVaraEthProvider(config.varaEthWs, { autoConnect: false });
  await ensureVaraEthProviderConnected(provider);
  const publicClient = createPublicClient({ transport: http(config.ethRpc) });
  const api = await createVaraEthApi(provider, publicClient, config.routerAddress);

  const parser = new SailsIdlParser();
  await parser.init();
  const idl = await (await fetch(idlUrl)).text();
  const program = new SailsProgram(parser.parse(idl));
  program.setProgramId(programId);

  return {
    api,
    provider,
    program,
    queries: worldQueries(program),
    actions: worldActions(program),
  };
}

// Arena cards need the contract's current participant state. Discovery is still
// useful for world metadata, but its indexed `agents` field can lag behind new
// registrations. One read-only API connection serves the entire card grid.
export async function readWorldAgentSummaries({ programIds = [], idlUrl, config = CHAIN }) {
  const ids = [...new Set(programIds
    .map((programId) => String(programId || '').trim().toLowerCase())
    .filter(Boolean))];
  if (ids.length === 0) return new Map();

  const connection = await connectWorldProgram({ programId: ids[0], idlUrl, config });
  try {
    const worldQueries = connection.program.services.World.queries;
    const agentsPayload = connection.queries.agents();
    const results = await Promise.allSettled(ids.map(async (programId) => {
      const reply = await calculateWorldReply({
        api: connection.api,
        provider: connection.provider,
        source: READ_SOURCE,
        programId,
        payload: agentsPayload,
      });
      const owners = worldQueries.Agents.decodeResult(reply.payload);
      const states = await Promise.allSettled(owners.map(async (owner) => {
        const stateReply = await calculateWorldReply({
          api: connection.api,
          provider: connection.provider,
          source: READ_SOURCE,
          programId,
          payload: connection.queries.agentOf(owner),
        });
        return Number(worldQueries.AgentOf.decodeResult(stateReply.payload)[0]);
      }));
      const values = states
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      return [programId, {
        registered: owners.length,
        active: values.filter((status) => status === 1 || status === 2).length,
        dead: values.filter((status) => status === 3).length,
        exited: values.filter((status) => status === 4).length,
      }];
    }));
    return new Map(results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value));
  } finally {
    await connection.api?.provider?.disconnect?.();
  }
}

export function createWorldEventListener(options) {
  return new WorldBestStateListener(options);
}

export class WorldBestStateListener {
  constructor({
    program,
    programId,
    config = CHAIN,
    onEvent = () => {},
    onError = () => {},
    onSubscribed = () => {},
    WebSocketCtor = globalThis.WebSocket,
    reconnectMs = RECONNECT_MS,
    subscriptionAckMs = SUBSCRIPTION_ACK_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.program = program;
    this.programId = programId;
    this.config = config;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onSubscribed = onSubscribed;
    this.WebSocketCtor = WebSocketCtor;
    this.reconnectMs = reconnectMs;
    this.subscriptionAckMs = subscriptionAckMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.ws = null;
    this.requestId = 0;
    this.subscriptionRequestId = null;
    this.subscriptionId = null;
    this.started = false;
    this.hasSubscribed = false;
    this.reconnectTimer = null;
    this.subscriptionAckTimer = null;
    this.seen = new Set();
  }

  async start() {
    this.started = true;
    this.connectRaw();
  }

  tick() {}

  stop() {
    this.started = false;
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this._clearSubscriptionAckTimer();
    this.unsubscribe();
    this.ws?.close?.();
    this.ws = null;
    this.subscriptionRequestId = null;
    this.subscriptionId = null;
    this.hasSubscribed = false;
    this.seen.clear();
  }

  connectRaw() {
    if (!this.started || !this.config.varaEthWs || !this.programId) return;
    if (typeof this.WebSocketCtor !== 'function') {
      this.onError(new Error('WebSocket is not available in this browser'));
      return;
    }

    const ws = new this.WebSocketCtor(this.config.varaEthWs);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.subscriptionId = null;
      this.subscriptionRequestId = this.send(SUBSCRIBE_METHOD, [this.programId]);
      this._startSubscriptionAckTimer(ws);
    };
    ws.onmessage = (message) => {
      if (this.ws === ws) this.handleMessage(message.data);
    };
    ws.onerror = () => {
      this.onError(new Error('Vara.eth best-state WebSocket error'));
      if (this.ws === ws) ws.close?.();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._clearSubscriptionAckTimer();
      this.subscriptionId = null;
      this.subscriptionRequestId = null;
      if (this.started) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connectRaw();
    }, this.reconnectMs);
  }

  send(method, params = []) {
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return null;
    const id = ++this.requestId;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  unsubscribe() {
    if (this.subscriptionId === null || !this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return;
    this.send(UNSUBSCRIBE_METHOD, [this.subscriptionId]);
    this.subscriptionId = null;
  }

  _startSubscriptionAckTimer(ws) {
    this._clearSubscriptionAckTimer();
    this.subscriptionAckTimer = this.setTimer(() => {
      this.subscriptionAckTimer = null;
      if (this.ws !== ws || this.subscriptionId !== null) return;
      this.onError(new Error('Vara.eth best-state subscription acknowledgement timed out'));
      ws.close?.();
    }, this.subscriptionAckMs);
  }

  _clearSubscriptionAckTimer() {
    if (this.subscriptionAckTimer !== null) this.clearTimer(this.subscriptionAckTimer);
    this.subscriptionAckTimer = null;
  }

  handleMessage(data) {
    let raw = data;
    if (typeof raw !== 'string') raw = new TextDecoder().decode(raw);

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.onError(new Error('Invalid Vara.eth best-state JSON-RPC message'));
      return;
    }

    if (message.error) {
      const error = new Error(rpcErrorMessage(message.error));
      this.onError(error);
      if (message.error?.code === -32601) this.stop();
      else this.ws?.close?.();
      return;
    }

    if (message.id === this.subscriptionRequestId && isSubscriptionId(message.result)) {
      this.subscriptionId = message.result;
      this._clearSubscriptionAckTimer();
      const reconnected = this.hasSubscribed;
      this.hasSubscribed = true;
      this.onSubscribed({ reconnected });
      return;
    }

    const bestState = notificationResult(message);
    if (!bestState?.messages) return;
    this.handleBestState(bestState);
  }

  handleBestState(bestState) {
    const messages = Array.isArray(bestState.messages) ? bestState.messages : [];
    messages.forEach((message, index) => {
      const event = this.decodeMessage(message, bestState, index);
      if (event) this.onEvent(event);
    });
  }

  decodeMessage(message, bestState, index) {
    if (!isZeroDestination(messageDestination(message))) return null;

    const payload = messagePayload(message);
    const hex = bytesToHex(payload);
    if (!hex) return null;

    const messageId = message?.id || message?.message_id || message?.hash || null;
    const mbHash = bestStateMbHash(bestState);
    const stateHash = bestStateNewHash(bestState);
    const key = `${mbHash}:${index}:${messageId || hex}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));

    try {
      const decoded = decodeProgramEvent(this.program, hex);
      if (!decoded) return null;
      const mapped = decodeWorldEvent(decoded.event, decoded.data);
      if (!mapped) return null;
      return {
        ...mapped,
        id: key,
        source: 'vara-eth-best-state',
        programId: this.programId,
        service: decoded.service,
        chainEvent: decoded.event,
        mbHash: mbHash || null,
        stateHash: stateHash || null,
        messageId,
        messageIndex: index,
      };
    } catch {
      return null;
    }
  }
}

function isSubscriptionId(value) {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}
