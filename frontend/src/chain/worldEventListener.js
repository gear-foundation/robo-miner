import { CHAIN } from './config.js';
import { decodeWorldEvent, worldActions, worldQueries } from './world.js';

const MAX_BLOCK_BACKFILL = 24;

function normalizeActorId(value) {
  const text = String(value || '').toLowerCase();
  if (!text.startsWith('0x')) return text;
  return text.length === 66 && text.startsWith('0x000000000000000000000000')
    ? `0x${text.slice(-40)}`
    : text;
}

function sameActor(a, b) {
  return Boolean(a && b && normalizeActorId(a) === normalizeActorId(b));
}

function bytesToHex(bytes) {
  if (typeof bytes === 'string') return bytes;
  return `0x${Array.from(bytes || []).map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
}

function eventRequestPayload(request) {
  return request?.payload || request?.reply?.payload || request?.data?.payload || null;
}

export async function connectWorldProgram({ programId, idlUrl, config = CHAIN }) {
  const { Buffer } = await import('buffer');
  globalThis.Buffer ||= Buffer;
  const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
  const { createPublicClient, http } = await import('viem');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');

  const provider = new WsVaraEthProvider(config.varaEthWs);
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

export function createWorldEventListener(options) {
  return new WorldEventListener(options);
}

export class WorldEventListener {
  constructor({
    api,
    program,
    programId,
    pollMs = CHAIN.pollMs,
    onEvent = () => {},
    onError = () => {},
  }) {
    this.api = api;
    this.program = program;
    this.programId = programId;
    this.pollMs = Math.max(400, Number(pollMs || 1000));
    this.onEvent = onEvent;
    this.onError = onError;
    this.pollInMs = this.pollMs;
    this.draining = false;
    this.lastBlockHash = null;
    this.lastBlockHeight = 0;
    this.seen = new Set();
  }

  async start() {
    await this.primeCursor();
  }

  stop() {
    this.seen.clear();
  }

  tick(dtMs = 0) {
    this.pollInMs -= dtMs;
    if (this.pollInMs > 0 || this.draining) return;
    this.pollInMs = this.pollMs;
    this.drain().catch((error) => this.onError(error));
  }

  async primeCursor() {
    const header = await this.api.query.block.header();
    this.lastBlockHash = header.hash;
    this.lastBlockHeight = Number(header.height || 0);
  }

  async drain() {
    if (!this.lastBlockHash) {
      await this.primeCursor();
      return;
    }

    this.draining = true;
    try {
      const latest = await this.api.query.block.header();
      if (!latest?.hash) return;
      if (latest.hash === this.lastBlockHash) return;

      const chain = [];
      let cursor = latest;
      let foundCursor = false;
      for (let i = 0; cursor && i < MAX_BLOCK_BACKFILL; i += 1) {
        if (cursor.hash === this.lastBlockHash) {
          foundCursor = true;
          break;
        }
        chain.push(cursor);
        if (!cursor.parentHash) break;
        cursor = await this.api.query.block.header(cursor.parentHash);
      }

      if (!foundCursor) {
        this.onError(new Error(`chain event gap from block ${this.lastBlockHeight} to ${latest.height}; reload world to resync`));
        this.lastBlockHash = latest.hash;
        this.lastBlockHeight = Number(latest.height || this.lastBlockHeight);
        return;
      }

      let decodedEvents = 0;
      for (const header of chain.reverse()) {
        const result = await this.processBlock(header);
        decodedEvents += result.decodedEvents;
        this.lastBlockHash = header.hash;
        this.lastBlockHeight = Number(header.height || this.lastBlockHeight);
      }
    } finally {
      this.draining = false;
    }
  }

  async processBlock(header) {
    let rawEvents = [];
    try {
      rawEvents = await this.api.query.block.events(header.hash);
    } catch (error) {
      this.onError(error);
      return { decodedEvents: 0 };
    }

    let emitted = 0;
    for (const raw of rawEvents || []) {
      const decoded = this.decodeBlockEvent(raw, header);
      if (!decoded) continue;
      if (decoded.event) {
        emitted += 1;
        this.onEvent(decoded.event);
      }
    }
    return { decodedEvents: emitted };
  }

  decodeBlockEvent(raw, header) {
    const mirror = raw?.Mirror;
    if (!mirror || !sameActor(mirror.actorId, this.programId)) return null;

    const request = mirror.event?.MessageQueueingRequested
      || mirror.event?.ReplyQueueingRequested
      || null;
    if (!request) return { touchesProgram: true, event: null };

    const key = `${header.hash}:${request.id || request.repliedTo || bytesToHex(request.payload || [])}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));

    const payload = eventRequestPayload(request);
    const event = payload ? this.decodeSailsEvent(payload) : null;
    return {
      touchesProgram: true,
      event: event ? {
        ...event,
        id: key,
        source: 'vara-eth',
        programId: this.programId,
        blockHash: header.hash,
        blockNumber: header.height,
        messageId: request.id || request.repliedTo || null,
      } : null,
    };
  }

  decodeSailsEvent(payload) {
    const hex = bytesToHex(payload);
    try {
      const decoded = this.program.decodeEvent(hex);
      if (decoded?.kind !== 'event' || decoded.entry?.kind !== 'event') return null;
      const mapped = decodeWorldEvent(decoded.entry.event, decoded.data);
      return mapped ? { ...mapped, chainEvent: decoded.entry.event } : null;
    } catch {
      return null;
    }
  }
}
