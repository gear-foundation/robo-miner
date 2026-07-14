// Agent discovery endpoint — the single address agents scan to find current
// matches and learn how to join. It serves the factory's live world list (no DB,
// always fresh from memory). Works identically in dry-run and battle mode, so the
// agent integration is the same whether we're testing or live.
//
//   GET /matches  → joinable registration/in-game matches + how-to-register block
//   GET /sessions → every live/archive session (CURRENT + PAST)
//   GET /health   → liveness + counts
//
// An agent: poll /matches → pick one with slotsFree > 0 → send an injected
// World.Register(owner) while status=open/active → wait for active → play.

import http from 'node:http';
import { worldIdentity } from '../../worldRegistry/identity.js';

const DIR_HINT = '0=up 1=right 2=down 3=left (4=current, for place_ladder under-foot)';
const PAST_STATUSES = new Set(['finished', 'retired', 'archived']);
const JOINABLE_STATUSES = new Set(['open', 'active']);

export function createDiscoveryServer({ factory, env = {}, cfg, archives = null, port = 8781, log = console.log }) {
  const sessionRecord = (w) => {
    const identity = worldIdentity(w);
    const status = publicStatus(w.status);
    const agents = w.agents ?? 0;
    const maxAgents = w.capAgents ?? 0;
    const canRegister = JOINABLE_STATUSES.has(status) && agents < maxAgents;
    const sessionKey = w.archiveId || `${w.id}-s${w.sessionId ?? 0}`;
    const archiveId = status === 'archived' ? sessionKey : (w.archiveId || null);
    return {
      id: status === 'archived' ? sessionKey : w.id,
      ...identity,
      sessionKey,
      programId: w.programId,
      status, // open | active | archived
      phase: status,
      joinable: canRegister,
      canRegister,
      canPlay: status === 'active',
      agents,
      minAgents: w.minAgents,
      maxAgents,
      slotsFree: Math.max(0, maxAgents - agents),
      owners: w.owners || [], // real participants already registered
      seed: w.seed,
      mapHash: w.mapHash || null,
      sessionId: w.sessionId,
      startsAt: w.startedAt || null,
      endsAt: cfg.sessionAutofinish && w.startedAt ? w.startedAt + cfg.sessionMs : null,
      sessionAutofinish: Boolean(cfg.sessionAutofinish),
      finishedAt: w.finishedAt || null,
      archivedAt: w.archivedAt || null,
      archiveId,
      archiveUrl: w.archiveUrl || (archiveId ? `/archives/${encodeURIComponent(archiveId)}` : null),
    };
  };

  const registerInfo = () => ({
    network: env.network || 'mainnet',
    router: env.router || null,
    varaWs: env.varaWs || null, // Vara.eth node to send injected txs / read state
    ethRpc: env.ethRpc || null,
    gasless: true, // the match's executable balance pays — your EOA needs no funds
    owner: "actorId of your address: '0x' + 24 zero bytes (12) + your 20-byte EOA",
    steps: [
      'GET /matches and pick a match where joinable=true; retain match.worldLabel for display and match.programId for chain calls',
      'Send an injected World.Register(owner) to that match.programId',
      'Wait until the session is active (the operator starts it at minAgents, or the contract auto-starts at maxAgents)',
      'Play with injected txs: Drill(dir) / MoveAgent(dir) / PlaceLadder(dir) / Surface()',
    ],
    actions: { drill: 'Drill(dir)', move: 'MoveAgent(dir)', ladder: 'PlaceLadder(dir)', surface: 'Surface()' },
    directions: DIR_HINT,
  });

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body, null, 2));
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0].replace(/\/$/, '') || '/matches';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    const all = factory.snapshot();
    if (url === '/matches' || url === '/') {
      const open = all.map(sessionRecord).filter((w) => w.joinable);
      json(res, 200, { updatedAt: new Date().toISOString(), register: registerInfo(), matches: open });
    } else if (url === '/sessions') {
      const sessions = all.map(sessionRecord);
      json(res, 200, { updatedAt: new Date().toISOString(), sessions });
    } else if (url.startsWith('/archives/')) {
      if (!archives) {
        json(res, 404, { error: 'archive store is not configured' });
        return;
      }
      const archiveId = decodeURIComponent(url.slice('/archives/'.length));
      try {
        json(res, 200, await archives.read(archiveId));
      } catch (error) {
        json(res, 404, { error: 'archive not found', archiveId, message: error?.message || String(error) });
      }
    } else if (url === '/health') {
      json(res, 200, { ok: true, worlds: all.length, open: all.filter((w) => w.status === 'open').length });
    } else {
      json(res, 404, { error: 'not found', endpoints: ['/matches', '/sessions', '/archives/:id', '/health'] });
    }
  });

  return {
    url: `http://localhost:${port}`,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          const hint = error?.code === 'EADDRINUSE'
            ? `discovery port ${port} is already in use; set DISCOVERY_PORT to a free port`
            : `discovery server failed: ${error?.message || error}`;
          reject(new Error(hint));
        };
        const onListening = () => {
          server.off('error', onError);
          log(`[discovery] agents scan matches → http://localhost:${port}/matches`);
          resolve();
        };
        server.once('error', onError);
        server.listen(port, onListening);
      });
    },
    stop() { try { server.close(); } catch { /* ignore */ } },
  };
}

function publicStatus(status) {
  const value = String(status || '');
  return PAST_STATUSES.has(value) ? 'archived' : value;
}
