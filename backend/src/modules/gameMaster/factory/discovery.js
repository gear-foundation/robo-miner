// Agent discovery endpoint — the single address agents scan to find current
// matches and learn how to join. It serves the factory's live world list (no DB,
// always fresh from memory). Works identically in dry-run and battle mode, so the
// agent integration is the same whether we're testing or live.
//
//   GET /matches  → open, joinable matches + how-to-register block (the main feed)
//   GET /worlds   → every world incl. finished/archived (CURRENT + PAST)
//   GET /health   → liveness + counts
//
// An agent: poll /matches → pick one with slotsFree > 0 → send an injected
// World.Register(owner) to its `programId` with its own key (gasless) → play.

import http from 'node:http';

const DIR_HINT = '0=up 1=right 2=down 3=left (4=current, for place_ladder under-foot)';

export function createDiscoveryServer({ factory, env = {}, cfg, port = 8780, log = console.log }) {
  const matchRecord = (w) => ({
    id: w.id,
    programId: w.programId,
    status: w.status, // open | active | finished | …
    joinable: w.status === 'open' && (w.agents ?? 0) < (w.capAgents ?? 0),
    agents: w.agents ?? 0,
    minAgents: w.minAgents,
    maxAgents: w.capAgents,
    slotsFree: Math.max(0, (w.capAgents ?? 0) - (w.agents ?? 0)),
    owners: w.owners || [], // real participants already registered
    seed: w.seed,
    sessionId: w.sessionId,
    startsAt: w.startedAt || null,
    endsAt: w.startedAt ? w.startedAt + cfg.sessionMs : null,
  });

  const registerInfo = () => ({
    network: env.network || 'hoodi',
    router: env.router || null,
    varaWs: env.varaWs || null, // Vara.eth node to send injected txs / read state
    ethRpc: env.ethRpc || null,
    gasless: true, // the match's executable balance pays — your EOA needs no funds
    owner: "actorId of your address: '0x' + 24 zero bytes (12) + your 20-byte EOA",
    steps: [
      'GET /matches and pick a match where joinable=true (slotsFree > 0)',
      'Send an injected World.Register(owner) to that match.programId',
      'Wait until the session is ACTIVE (auto-starts at maxAgents; or backend starts from minAgents)',
      'Play with injected txs: Drill(dir) / MoveAgent(dir) / PlaceLadder(dir) / Surface()',
    ],
    actions: { drill: 'Drill(dir)', move: 'MoveAgent(dir)', ladder: 'PlaceLadder(dir)', surface: 'Surface()' },
    directions: DIR_HINT,
  });

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body, null, 2));
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0].replace(/\/$/, '') || '/matches';
    const all = factory.snapshot();
    if (url === '/matches' || url === '/') {
      const open = all.filter((w) => w.status === 'open');
      json(res, 200, { updatedAt: new Date().toISOString(), register: registerInfo(), matches: open.map(matchRecord) });
    } else if (url === '/worlds') {
      json(res, 200, { updatedAt: new Date().toISOString(), worlds: all.map(matchRecord) });
    } else if (url === '/health') {
      json(res, 200, { ok: true, worlds: all.length, open: all.filter((w) => w.status === 'open').length });
    } else {
      json(res, 404, { error: 'not found', endpoints: ['/matches', '/worlds', '/health'] });
    }
  });

  return {
    url: `http://localhost:${port}`,
    start() {
      server.listen(port, () => log(`[discovery] agents scan matches → http://localhost:${port}/matches`));
    },
    stop() { try { server.close(); } catch { /* ignore */ } },
  };
}
