#!/usr/bin/env node

import http from 'node:http';
import { createVaraEthChain } from '../chain/varaEth.js';
import { loadConfig } from '../config/index.js';
import { createStore } from '../db/store.js';
import { EventBus } from './eventBus.js';
import { streamEvents, wantsEventStream } from './eventStream.js';
import { AdminService } from '../modules/admin/service.js';
import { DiggerRegistryService } from '../modules/diggerRegistry/service.js';
import { DiggerRentalService } from '../modules/diggerRental/service.js';
import { InjectedIngestService } from '../modules/indexer/injectedIngest.js';
import { LeaderboardService } from '../modules/leaderboard/service.js';
import { SocialVerifierService } from '../modules/socialVerifier/service.js';
import { discoveryFromManifest } from '../modules/worldRegistry/discovery.js';
import { WorldRegistryService } from '../modules/worldRegistry/service.js';
import { createLogger, errorFields } from '../logger.js';

const config = loadConfig();
const store = createStore(config);
const logger = createLogger('api');
const eventBus = new EventBus();
const registry = new WorldRegistryService({
  store,
  config,
});
const diggerRegistry = new DiggerRegistryService({
  store,
  config,
});
const injectedIngest = new InjectedIngestService({
  store,
  config,
  eventBus,
});
const leaderboardService = new LeaderboardService({
  store,
  config,
});
const dryRunRental = new DiggerRentalService({
  store,
  chain: null,
  config,
});
const adminService = new AdminService({
  store,
  config,
  chainFactory: () => createVaraEthChain(config),
  logger: createLogger('admin'),
});
const socialVerifier = new SocialVerifierService({
  store,
  config,
  chainFactory: () => createVaraEthChain(config),
  logger: createLogger('social'),
});

const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 8787);

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let url = null;
  try {
    if (req.method === 'OPTIONS') {
      return json(res, 204, null);
    }
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    logger.info('request.start', {
      method: req.method,
      path: url.pathname,
    });
    if (url.pathname.startsWith('/api/admin/') && !authorizedAdmin(req)) {
      logger.warn('admin.unauthorized', { method: req.method, path: url.pathname });
      return json(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/matches')) {
      const discovery = discoveryFromManifest(await registry.getManifest(), config);
      return json(res, 200, {
        updatedAt: discovery.updatedAt,
        register: discovery.register,
        matches: discovery.matches,
      });
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const discovery = discoveryFromManifest(await registry.getManifest(), config);
      return json(res, 200, {
        updatedAt: discovery.updatedAt,
        sessions: discovery.sessions,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/season/current') {
      return json(res, 200, await registry.getCurrentSeason());
    }
    if (req.method === 'GET' && url.pathname === '/api/worlds/live') {
      return json(res, 200, { worlds: await registry.getLiveWorlds() });
    }
    if (req.method === 'GET' && url.pathname === '/api/worlds') {
      const manifest = await registry.getManifest();
      return json(res, 200, { worlds: manifest.worlds });
    }
    if (req.method === 'GET' && url.pathname === '/api/manifest') {
      return json(res, 200, await registry.getManifest());
    }
    if (req.method === 'GET' && url.pathname === '/api/diggers') {
      const diggers = await diggerRegistry.list({
        seasonId: url.searchParams.get('season') || null,
        worldId: url.searchParams.get('world') || null,
        owner: url.searchParams.get('owner') || null,
        status: url.searchParams.get('status') || null,
      });
      return json(res, 200, {
        digger: diggers[0] || null,
        diggers,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/diggers/request') {
      const body = await readJsonBody(req);
      const dryRun = body.dryRun ?? config.diggerRentalMode !== 'live';
      logger.info('digger.request.received', {
        owner: body.owner,
        worldId: body.worldId,
        seasonId: body.seasonId || null,
        dryRun,
      });
      let chain = null;
      try {
        chain = dryRun ? null : await createVaraEthChain(config);
        const rental = dryRun ? dryRunRental : new DiggerRentalService({ store, chain, config });
        return json(res, dryRun ? 202 : 201, await rental.requestDigger({
          owner: body.owner,
          worldId: body.worldId,
          seasonId: body.seasonId || null,
          dryRun,
          requestId: body.requestId || null,
          codeId: body.codeId || null,
          initialTopUp: body.initialTopUp || null,
        }));
      } finally {
        await chain?.disconnect?.();
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/stats/agents') {
      const db = await store.read();
      return json(res, 200, {
        agents: db.agentStats
          .filter((item) => !url.searchParams.get('season') || item.seasonId === url.searchParams.get('season'))
          .filter((item) => !url.searchParams.get('world') || item.worldId === url.searchParams.get('world')),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats/economy') {
      const db = await store.read();
      return json(res, 200, { economy: db.economyStats });
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const filters = leaderboardFilters(url);
      return json(res, 200, {
        metric: filters.metric,
        summary: url.searchParams.get('summary') === 'true' ? await leaderboardService.summary(filters) : undefined,
        leaderboard: await leaderboardService.list(filters),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (wantsEventStream(req, url)) {
        logger.info('events.stream.open');
        await streamEvents(req, res, { store, logger, eventBus });
        return;
      }
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const db = await store.read();
      return json(res, 200, { events: db.chainEvents.slice(-limit) });
    }
    if (req.method === 'POST' && url.pathname === '/api/social/x/submit') {
      const body = await readJsonBody(req);
      logger.info('social.x.submit', {
        owner: body.owner,
        taskType: body.taskType,
        seasonId: body.seasonId || null,
        dryRun: body.dryRun ?? config.diggerRentalMode !== 'live',
      });
      return json(res, 202, await socialVerifier.submitXTask({
        owner: body.owner,
        taskType: body.taskType,
        tweetUrl: body.tweetUrl,
        xUsername: body.xUsername || '',
        seasonId: body.seasonId || null,
        diggerProgramId: body.diggerProgramId || null,
        dryRun: body.dryRun ?? null,
      }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/social/x/')) {
      const owner = decodeURIComponent(url.pathname.slice('/api/social/x/'.length));
      return json(res, 200, {
        submissions: await socialVerifier.listSubmissions({
          owner,
          limit: limitParam(url, 200, 100),
        }),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      return json(res, 200, await adminService.overview());
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/rental/requests') {
      return json(res, 200, {
        requests: await adminService.rentalRequests({
          status: url.searchParams.get('status') || null,
          limit: limitParam(url, 200, 100),
        }),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/rental/fuel-grants') {
      return json(res, 200, {
        grants: await adminService.fuelGrants({
          programId: url.searchParams.get('program') || null,
          limit: limitParam(url, 200, 100),
        }),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/social/x') {
      return json(res, 200, {
        submissions: await socialVerifier.listSubmissions({
          owner: url.searchParams.get('owner') || null,
          limit: limitParam(url, 500, 100),
        }),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/rental/clear-failed') {
      logger.warn('admin.rental.clear_failed');
      return json(res, 200, await adminService.clearFailedRentalRequests());
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/redeem') {
      const programId = url.searchParams.get('program') || config.redeemProgramIds[0];
      if (!programId) return json(res, 400, { error: 'missing_redeem_program' });
      return json(res, 200, await adminService.readRedeem(programId));
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/redeem/deposit') {
      const body = await readJsonBody(req);
      const programId = body.programId || config.redeemProgramIds[0];
      if (!programId) return json(res, 400, { error: 'missing_redeem_program' });
      if (!body.amount) return json(res, 400, { error: 'missing_amount' });
      const dryRun = body.dryRun ?? config.diggerRentalMode !== 'live';
      logger.info('admin.redeem.deposit', { programId, amount: body.amount, dryRun });
      return json(res, dryRun ? 202 : 201, await adminService.depositRedeemReserve({
        programId,
        amount: body.amount,
        dryRun,
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/ingest/injected') {
      const body = await readJsonBody(req);
      return json(res, 202, await injectedIngest.ingest(body));
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    logger.error('request.failed', {
      method: req.method,
      path: url?.pathname || null,
      durationMs: Date.now() - startedAt,
      ...errorFields(error),
    });
    if (error.statusCode) {
      return json(res, error.statusCode, { error: error.message });
    }
    return json(res, 500, { error: 'internal_error', message: error.message });
  }
});

server.listen(PORT, () => {
  logger.info('server.listening', {
    url: `http://localhost:${PORT}`,
    adminAuth: Boolean(config.adminApiToken),
  });
});

function json(res, status, payload) {
  const body = status === 204 ? '' : `${JSON.stringify(payload, bigintReplacer, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function leaderboardFilters(url) {
  return {
    seasonId: url.searchParams.get('season') || null,
    worldId: url.searchParams.get('world') || null,
    sessionId: url.searchParams.get('session') || null,
    owner: url.searchParams.get('owner') || null,
    metric: url.searchParams.get('metric') || 'banked',
    limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50))),
  };
}

function limitParam(url, max, fallback) {
  return Math.min(max, Math.max(1, Number(url.searchParams.get('limit') || fallback)));
}

function authorizedAdmin(req) {
  if (!config.adminApiToken) return true;
  return req.headers.authorization === `Bearer ${config.adminApiToken}`;
}
