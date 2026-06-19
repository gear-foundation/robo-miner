import { CONTRACT_IDLS } from './idlRegistry.js';
import { decodeProgramEvent, programsFromConfig } from './liveReader.js';

const SUBSCRIBE_METHOD = 'program_subscribeBestState';
const UNSUBSCRIBE_METHOD = 'program_unsubscribeBestState';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_RECONNECT_MS = 1500;

export class BestStateEventReader {
  constructor({
    config,
    programs = [],
    onEvents = async () => {},
    logger = null,
    reconnectMs = DEFAULT_RECONNECT_MS,
  }) {
    this.config = config;
    this.programs = (programs.length > 0 ? programs : config.indexerPrograms || programsFromConfig(config))
      .map(normalizeProgramConfig)
      .filter((program) => CONTRACT_IDLS[program.programType]);
    this.onEvents = onEvents;
    this.logger = logger;
    this.reconnectMs = reconnectMs;
    this.sailsByType = new Map();
    this.subscriptions = new Map();
    this.seen = new Set();
    this.started = false;
    this.WebSocket = null;
    this.queue = Promise.resolve();
  }

  async start() {
    if (this.programs.length === 0) {
      throw new Error('No best-state programs configured. Sync worlds or set INDEXER_WORLD_PROGRAM_IDS/WORLD_PROGRAM_ID.');
    }
    await this.loadSails();
    const { WebSocket } = await import('isows');
    this.WebSocket = WebSocket;
    this.started = true;
    for (const program of this.programs) {
      this.startProgram(program);
    }
  }

  async stop() {
    this.started = false;
    for (const sub of this.subscriptions.values()) {
      if (sub.reconnectTimer) clearTimeout(sub.reconnectTimer);
      sub.reconnectTimer = null;
      this.unsubscribe(sub);
      sub.ws?.close?.();
      sub.ws = null;
    }
    this.subscriptions.clear();
    await this.queue.catch(() => {});
  }

  async loadSails() {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { SailsProgram } = await import('sails-js');
    const { SailsIdlParser } = await import('sails-js/parser');
    const parser = new SailsIdlParser();
    await parser.init();
    const neededTypes = [...new Set(this.programs.map((program) => program.programType))];
    for (const programType of neededTypes) {
      const relative = CONTRACT_IDLS[programType];
      const file = path.resolve(this.config.rootDir, '..', relative);
      const idl = await readFile(file, 'utf8');
      this.sailsByType.set(programType, new SailsProgram(parser.parse(idl)));
    }
  }

  startProgram(program) {
    const key = `${program.programType}:${program.programId}`;
    if (this.subscriptions.has(key)) return;
    const sub = {
      key,
      program,
      ws: null,
      requestId: 0,
      subscriptionId: null,
      reconnectTimer: null,
    };
    this.subscriptions.set(key, sub);
    this.connect(sub);
  }

  connect(sub) {
    if (!this.started || !this.config.varaEthWs) return;
    const ws = new this.WebSocket(this.config.varaEthWs);
    sub.ws = ws;

    attachWs(ws, 'open', () => {
      sub.subscriptionId = null;
      this.send(sub, SUBSCRIBE_METHOD, [sub.program.programId]);
    });
    attachWs(ws, 'message', (message) => {
      this.handleMessage(sub, message?.data ?? message);
    });
    attachWs(ws, 'error', (error) => {
      this.logger?.warn?.('best_state.ws.error', {
        programType: sub.program.programType,
        programId: sub.program.programId,
        error: errorMessage(error),
      });
    });
    attachWs(ws, 'close', () => {
      if (sub.ws === ws) sub.ws = null;
      sub.subscriptionId = null;
      if (this.started) this.scheduleReconnect(sub);
    });
  }

  scheduleReconnect(sub) {
    if (sub.reconnectTimer) return;
    sub.reconnectTimer = setTimeout(() => {
      sub.reconnectTimer = null;
      this.connect(sub);
    }, this.reconnectMs);
  }

  send(sub, method, params = []) {
    if (!sub.ws || sub.ws.readyState !== this.WebSocket.OPEN) return null;
    const id = ++sub.requestId;
    sub.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  unsubscribe(sub) {
    if (!sub.subscriptionId || !sub.ws || sub.ws.readyState !== this.WebSocket.OPEN) return;
    this.send(sub, UNSUBSCRIBE_METHOD, [sub.subscriptionId]);
    sub.subscriptionId = null;
  }

  handleMessage(sub, data) {
    let raw = data;
    if (raw instanceof ArrayBuffer) raw = new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) raw = new TextDecoder().decode(raw);
    if (typeof raw !== 'string') raw = String(raw || '');

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.logger?.warn?.('best_state.invalid_json', { programId: sub.program.programId });
      return;
    }

    if (message.error) {
      this.logger?.warn?.('best_state.rpc.error', {
        programType: sub.program.programType,
        programId: sub.program.programId,
        error: rpcErrorMessage(message.error),
      });
      return;
    }

    if (message.id && typeof message.result === 'string') {
      sub.subscriptionId = message.result;
      this.logger?.info?.('best_state.subscribed', {
        programType: sub.program.programType,
        programId: sub.program.programId,
        subscriptionId: sub.subscriptionId,
      });
      return;
    }

    const bestState = notificationResult(message);
    if (!bestState?.messages) return;
    this.handleBestState(sub, bestState);
  }

  handleBestState(sub, bestState) {
    const events = [];
    const messages = Array.isArray(bestState.messages) ? bestState.messages : [];
    messages.forEach((message, index) => {
      const event = this.decodeMessage(sub, message, bestState, index);
      if (event) events.push(event);
    });
    if (events.length === 0) return;

    this.queue = this.queue
      .then(() => this.onEvents(events))
      .catch((error) => {
        this.logger?.error?.('best_state.apply.failed', {
          programId: sub.program.programId,
          error: errorMessage(error),
        });
      });
  }

  decodeMessage(sub, message, bestState, index) {
    if (!isZeroDestination(messageDestination(message))) return null;

    const payload = bytesToHex(messagePayload(message));
    if (!payload) return null;

    const sails = this.sailsByType.get(sub.program.programType);
    if (!sails) return null;

    const decoded = decodeProgramEvent(sails, payload);
    if (!decoded || decoded.kind === 'unknown') return null;

    const messageId = message?.id || message?.message_id || message?.hash || null;
    const mbHash = bestStateMbHash(bestState);
    const stateHash = bestStateNewHash(bestState);
    const dedupeKey = `${sub.program.programId}:${mbHash || stateHash || 'best-state'}:${index}:${messageId || payload}`;
    if (this.seen.has(dedupeKey)) return null;
    this.seen.add(dedupeKey);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));

    return {
      id: [
        sub.program.programId,
        mbHash || stateHash || 'best-state',
        index,
        messageId || payload,
        decoded.service,
        decoded.event,
      ].join(':'),
      source: 'vara-eth-best-state',
      programType: sub.program.programType,
      programId: sub.program.programId,
      service: decoded.service,
      event: decoded.event,
      args: decoded.data,
      blockHash: mbHash || stateHash || null,
      messageId,
      logIndex: index,
      timestamp: new Date().toISOString(),
    };
  }
}

function attachWs(ws, event, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
    return;
  }
  if (typeof ws.on === 'function') {
    ws.on(event, handler);
    return;
  }
  ws[`on${event}`] = handler;
}

function notificationResult(message) {
  if (!message || !message.method) return null;
  return message.params?.result || message.result || null;
}

function rpcErrorMessage(error) {
  if (!error) return 'unknown RPC error';
  if (error.code === -32601) return `${SUBSCRIBE_METHOD} is not available on this Vara.eth RPC`;
  return error.message || JSON.stringify(error);
}

function bestStateMbHash(bestState) {
  return bestState?.mbHash || bestState?.mb_hash || '';
}

function bestStateNewHash(bestState) {
  return bestState?.newStateHash || bestState?.new_state_hash || '';
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

function isZeroDestination(destination) {
  const hex = destinationHex(destination);
  if (!hex) return true;
  const bytes = hex.startsWith('0x') ? hex.slice(2) : hex;
  return /^0+$/.test(bytes);
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

function bytesToHex(bytes) {
  if (!bytes) return '';
  if (typeof bytes === 'string') return bytes.startsWith('0x') ? bytes.toLowerCase() : `0x${bytes.toLowerCase()}`;
  if (Array.isArray(bytes)) {
    return `0x${bytes.map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
  }
  if (ArrayBuffer.isView(bytes)) {
    return `0x${Array.from(bytes).map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof bytes === 'object' && bytes.bytes) return bytesToHex(bytes.bytes);
  return '';
}

function normalizeProgramConfig(program) {
  return {
    programType: program.programType,
    programId: normalizeActorAddress(program.programId),
  };
}

function normalizeActorAddress(value) {
  const hex = normalizeHex(value);
  return hex.length === 66 ? `0x${hex.slice(-40)}` : hex;
}

function normalizeHex(value) {
  const hex = String(value || '').trim().toLowerCase();
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
