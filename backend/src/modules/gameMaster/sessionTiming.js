export const SESSION_CREATED = 0;
export const SESSION_ACTIVE = 1;
export const SESSION_FINISHED = 2;

export function applyWorldSessionTiming(world, { config = {}, timestamp, status }) {
  if (!world) return;
  const ts = parseDate(timestamp) || new Date();
  if (status === 'active') {
    const ms = sessionMs(world, config);
    const endsAt = new Date(ts.getTime() + ms).toISOString();
    world.session = { ...(world.session || {}), status: SESSION_ACTIVE };
    world.startsAt = ts.toISOString();
    world.endsAt = endsAt;
    world.sessionMs = ms;
    world.chain = { ...(world.chain || {}), startedAt: ts.toISOString() };
    world.finishedAt = null;
  }
  if (status === 'finished') {
    world.status = 'finished';
    world.session = { ...(world.session || {}), status: SESSION_FINISHED };
    world.finishedAt = ts.toISOString();
    world.chain = { ...(world.chain || {}), finishedAt: ts.toISOString() };
    if (!world.endsAt) world.endsAt = ts.toISOString();
  }
  if (status === 'waiting_agents') {
    if (world.session) world.session = { ...world.session, status: SESSION_CREATED };
    if ('endsAt' in world || world.endsAt) world.endsAt = null;
    if ('finishedAt' in world || world.finishedAt) world.finishedAt = null;
    if (world.chain?.startedAt || world.chain?.finishedAt) {
      const chain = { ...(world.chain || {}) };
      delete chain.startedAt;
      delete chain.finishedAt;
      world.chain = chain;
    }
  }
}

export function sessionMs(world, config = {}) {
  return Number(world.sessionMs || config.sessionMs || 30 * 60 * 1000);
}

function parseDate(value) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? new Date(ts) : null;
}
