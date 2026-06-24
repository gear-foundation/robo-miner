import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT_IDLS } from './idlRegistry.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class VaraEthLiveReader {
  constructor({ config, programs = [] }) {
    this.config = config;
    this.programs = (programs.length > 0 ? programs : config.indexerPrograms || []).map(normalizeProgramConfig);
    this.provider = null;
    this.sailsByType = new Map();
  }

  async connect() {
    if (this.programs.length === 0) {
      throw new Error('No indexer programs configured. Set WORLD_PROGRAM_ID, DIGGER_PROGRAM_IDS, DIGGER_RES_VMT_PROGRAM_ID, DIGGER_REDEEM_PROGRAM_ID, or sync worlds into backend DB.');
    }
    const { HttpVaraEthProvider, WsVaraEthProvider } = await import('@vara-eth/api');
    this.provider = createProvider(HttpVaraEthProvider, WsVaraEthProvider, this.config.varaEthWs, this.config.indexerTimeoutMs);
    await this.provider.connect();
    await this.loadSails();
  }

  async disconnect() {
    await this.provider?.disconnect?.();
  }

  async latestHeader() {
    return this.readHeader();
  }

  async readHeader(blockHash = null) {
    const params = blockHash ? [normalizeHex(blockHash)] : [];
    const response = await this.provider.send('block_header', params, { timeout: this.config.indexerTimeoutMs });
    return {
      hash: normalizeHex(response[0]),
      ...response[1],
    };
  }

  async readBlock(blockHash = null) {
    const header = await this.readHeader(blockHash);
    let transitions = [];
    let outcomeError = null;
    try {
      transitions = await this.provider.send('block_outcome', [header.hash], { timeout: this.config.indexerTimeoutMs });
      const { normalizeStateTransition } = await import('@vara-eth/api/util');
      transitions.forEach(normalizeStateTransition);
    } catch (error) {
      outcomeError = error instanceof Error ? error.message : String(error);
    }

    return {
      block: {
        hash: header.hash,
        height: header.height,
        timestamp: header.timestamp,
        parentHash: header.parentHash,
      },
      events: this.collectProgramEvents(transitions, header),
      outcomeError,
    };
  }

  collectProgramEvents(transitions, header) {
    const events = [];
    for (const transition of transitions) {
      const actorId = normalizeActorAddress(transition.actorId);
      const program = this.programs.find((item) => normalizeActorAddress(item.programId) === actorId);
      if (!program) continue;

      const sails = this.sailsByType.get(program.programType);
      if (!sails) continue;

      for (const message of transition.messages || []) {
        const destination = normalizeActorAddress(message.destination);
        if (destination !== ZERO_ADDRESS) continue;

        const payload = numberArrayToHex(message.payload);
        const decoded = decodeProgramEvent(sails, payload);
        if (!decoded || decoded.kind === 'unknown') continue;

        events.push({
          id: [
            actorId,
            header.hash,
            message.id || payload,
            decoded.service,
            decoded.event,
          ].join(':'),
          source: 'vara-eth',
          programType: program.programType,
          programId: program.programId,
          service: decoded.service,
          event: decoded.event,
          args: decoded.data,
          blockNumber: header.height,
          blockHash: header.hash,
          messageId: message.id || null,
          timestamp: timestampIso(header.timestamp),
        });
      }
    }
    return events;
  }

  async loadSails() {
    const { SailsProgram } = await import('sails-js');
    const { SailsIdlParser } = await import('sails-js/parser');
    const parser = new SailsIdlParser();
    await parser.init();
    const neededTypes = [...new Set(this.programs.map((program) => program.programType))];
    for (const programType of neededTypes) {
      const relative = CONTRACT_IDLS[programType];
      if (!relative) throw new Error(`No IDL configured for program type ${programType}`);
      const file = path.resolve(this.config.rootDir, '..', relative);
      const idl = await readFile(file, 'utf8');
      this.sailsByType.set(programType, new SailsProgram(parser.parse(idl)));
    }
  }
}

// Program ids come only from the already-assembled per-network config (loadConfig
// reads the env names into config.*ProgramIds). The read-layer must NOT re-read
// process.env directly, or one network's ids would leak into another.
export function programsFromConfig(config) {
  return uniquePrograms([
    ...programConfigs('world', config.worldProgramIds),
    ...programConfigs('proxy', config.diggerProgramIds),
    ...programConfigs('resVmt', config.resVmtProgramIds),
    ...programConfigs('redeem', config.redeemProgramIds),
  ]);
}

function programConfigs(programType, configured) {
  const raw = Array.isArray(configured) ? configured : splitList(configured);
  return raw
    .map((item) => {
      if (typeof item === 'string') return { programType, programId: item };
      return {
        programType: item.programType || programType,
        programId: item.programId,
      };
    })
    .filter((item) => item.programId);
}

function uniquePrograms(programs) {
  const seen = new Set();
  return programs.filter((program) => {
    const key = `${program.programType}:${String(program.programId).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function decodeProgramEvent(sails, payload) {
  if (typeof sails?.decodeEvent === 'function') {
    const decoded = sails.decodeEvent(payload);
    if (decoded.kind === 'event' && decoded.entry.kind === 'event') {
      return {
        service: decoded.entry.service,
        event: decoded.entry.event,
        data: jsonSafe(decoded.data),
      };
    }
    return { kind: 'unknown', reason: decoded.reason || decoded.kind };
  }

  for (const [serviceName, service] of Object.entries(sails?.services || {})) {
    for (const [eventName, event] of Object.entries(service?.events || {})) {
      try {
        return {
          service: serviceName,
          event: eventName,
          data: jsonSafe(event.decode(payload)),
        };
      } catch {
        // Best-state messages also include replies/calls; only program event
        // payloads match one of the Sails event headers.
      }
    }
  }
  return { kind: 'unknown', reason: 'no matching event decoder' };
}

function normalizeProgramConfig(program) {
  return {
    programType: program.programType,
    programId: normalizeActorAddress(program.programId),
  };
}

function createProvider(HttpVaraEthProvider, WsVaraEthProvider, rpcUrl, timeoutMs) {
  if (rpcUrl.startsWith('http://') || rpcUrl.startsWith('https://')) {
    return new HttpVaraEthProvider(rpcUrl, { requestTimeout: timeoutMs });
  }
  return new WsVaraEthProvider(rpcUrl, { autoConnect: false, requestTimeout: timeoutMs });
}

function normalizeHex(value) {
  const hex = String(value || '').trim().toLowerCase();
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

function normalizeActorAddress(value) {
  const hex = normalizeHex(value);
  return hex.length === 66 ? `0x${hex.slice(-40)}` : hex;
}

function numberArrayToHex(bytes) {
  return `0x${bytes.map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
}

function timestampIso(timestamp) {
  const value = Number(timestamp);
  const millis = value < 1_000_000_000_000 ? value * 1000 : value;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : new Date().toISOString();
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return numberArrayToHex([...value]);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
