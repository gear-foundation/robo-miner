import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT_IDLS } from './idlRegistry.js';
import { programsFromConfig } from './liveReader.js';

export class SnapshotReader {
  constructor({ config, programs = [] }) {
    this.config = config;
    this.programs = programs.length > 0 ? programs : config.indexerPrograms || programsFromConfig(config);
    this.api = null;
    this.signer = null;
    this.accountAddress = null;
    this.sailsByType = new Map();
  }

  async connect() {
    if (!this.config.ethRpc || !this.config.routerAddress) {
      throw new Error('ETH_RPC and ROUTER_ADDRESS are required for snapshot queries');
    }
    if (this.programs.length === 0) {
      throw new Error('No snapshot programs configured');
    }

    const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
    const { walletClientToSigner } = await import('@vara-eth/api/signer');
    const { createPublicClient, createWalletClient, http, webSocket } = await import('viem');
    const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');

    const account = privateKeyToAccount(generatePrivateKey());
    const transport = this.config.ethRpc.startsWith('ws') ? webSocket(this.config.ethRpc) : http(this.config.ethRpc);
    const publicClient = createPublicClient({ transport });
    const walletClient = createWalletClient({ account, transport });
    this.signer = walletClientToSigner(walletClient);
    this.accountAddress = await this.signer.getAddress();
    this.api = await createVaraEthApi(
      new WsVaraEthProvider(this.config.varaEthWs),
      publicClient,
      this.config.routerAddress,
      this.signer,
    );
    await this.loadSails();
  }

  async disconnect() {
    await this.api?.provider?.disconnect?.();
  }

  async readAll() {
    const snapshots = [];
    for (const program of this.programs) {
      if (program.programType === 'world') snapshots.push(await this.readWorld(program.programId));
      if (program.programType === 'proxy') snapshots.push(await this.readProxy(program.programId));
      if (program.programType === 'resVmt') snapshots.push(await this.readResVmt(program.programId));
      if (program.programType === 'redeem') snapshots.push(await this.readRedeem(program.programId));
    }
    return snapshots;
  }

  async readWorld(programId) {
    const program = this.sailsByType.get('world');
    const q = program.services.World.queries;
    const [session, config, agents] = await Promise.all([
      this.query(programId, q.Session),
      this.query(programId, q.Config),
      this.query(programId, q.Agents),
    ]);
    const owners = agents.map(actorKey);
    const agentStates = [];
    for (const owner of owners) {
      try {
        const [state, inventory] = await Promise.all([
          this.query(programId, q.AgentOf, actorArg(owner)),
          this.query(programId, q.InventoryOf, actorArg(owner)),
        ]);
        agentStates.push({ owner, state: state.map(toNumber), inventory: inventory.map(toNumber) });
      } catch (error) {
        agentStates.push({ owner, error: error.message });
      }
    }
    return {
      kind: 'world',
      programId,
      capturedAt: new Date().toISOString(),
      session: session.map(toStringNumber),
      config: config.map(toNumber),
      agents: agentStates,
    };
  }

  async readProxy(programId) {
    const program = this.sailsByType.get('proxy');
    const q = program.services.Digger.queries;
    const [owner, world, status, lastMessageId] = await Promise.all([
      this.query(programId, q.Owner),
      this.query(programId, q.World),
      this.query(programId, q.Status),
      this.query(programId, q.LastMessageId),
    ]);
    return {
      kind: 'proxy',
      programId,
      capturedAt: new Date().toISOString(),
      owner: actorKey(owner),
      world: actorKey(world),
      status: status.map(toStringNumber),
      lastMessageId: actorKey(lastMessageId),
    };
  }

  async readResVmt(programId) {
    const program = this.sailsByType.get('resVmt');
    const q = program.services.Vmt.queries;
    const totals = await Promise.all([0, 1, 2].map((id) => this.query(programId, q.TotalSupplyOf, id)));
    return {
      kind: 'resVmt',
      programId,
      capturedAt: new Date().toISOString(),
      totalSupply: {
        scrst: toNumber(totals[0]),
        bcrst: toNumber(totals[1]),
        hcrst: toNumber(totals[2]),
      },
    };
  }

  async readRedeem(programId) {
    const program = this.sailsByType.get('redeem');
    const q = program.services.Redeem.queries;
    const [
      reserveBalance,
      lockedBalance,
      totalPaid,
      totalRedeemedScrst,
      totalRedeemedBcrst,
      totalRedeemedHcrst,
      pendingRedeemCount,
    ] = await Promise.all([
      this.query(programId, q.ReserveBalance),
      this.query(programId, q.LockedBalance),
      this.query(programId, q.TotalPaid),
      this.query(programId, q.TotalRedeemedScrst),
      this.query(programId, q.TotalRedeemedBcrst),
      this.query(programId, q.TotalRedeemedHcrst),
      this.query(programId, q.PendingRedeemCount),
    ]);
    return {
      kind: 'redeem',
      programId,
      capturedAt: new Date().toISOString(),
      reserveBalance: toNumber(reserveBalance),
      lockedBalance: toNumber(lockedBalance),
      totalPaid: toNumber(totalPaid),
      totalRedeemed: {
        scrst: toNumber(totalRedeemedScrst),
        bcrst: toNumber(totalRedeemedBcrst),
        hcrst: toNumber(totalRedeemedHcrst),
      },
      pendingRedeemCount: toNumber(pendingRedeemCount),
    };
  }

  async query(programId, query, ...args) {
    const payload = query.encodePayload(...args);
    const reply = await this.api.call.program.calculateReplyForHandle(
      this.accountAddress,
      programId,
      payload,
      0n,
    );
    return query.decodeResult(reply.payload);
  }

  async loadSails() {
    const { SailsProgram } = await import('sails-js');
    const { SailsIdlParser } = await import('sails-js/parser');
    const parser = new SailsIdlParser();
    await parser.init();
    const neededTypes = [...new Set(this.programs.map((program) => program.programType))];
    for (const programType of neededTypes) {
      const relative = CONTRACT_IDLS[programType];
      if (!relative) continue;
      const file = path.resolve(this.config.rootDir, '..', relative);
      const idl = await readFile(file, 'utf8');
      const program = new SailsProgram(parser.parse(idl));
      this.sailsByType.set(programType, program);
    }
  }
}

export function actorKey(value) {
  if (Array.isArray(value)) return `0x${value.map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`.toLowerCase();
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object' && Array.isArray(value.bytes)) return actorKey(value.bytes);
  return String(value ?? '');
}

function actorArg(actor) {
  return actor;
}

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(String(value ?? 0));
}

function toStringNumber(value) {
  return String(value ?? 0);
}
