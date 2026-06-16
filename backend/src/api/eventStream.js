const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 15000;

export function wantsEventStream(req, url) {
  return url.searchParams.get('stream') === 'true'
    || String(req.headers.accept || '').includes('text/event-stream');
}

export async function streamEvents(req, res, { store, logger = null, pollMs = DEFAULT_POLL_MS, eventBus = null } = {}) {
  let closed = false;
  let polling = false;
  let cursor = 0;
  let pollTimer = null;
  let heartbeatTimer = null;
  let unsubscribe = null;
  const sentIds = new Set();

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write('retry: 1500\n');

  const close = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    unsubscribe?.();
    logger?.info?.('events.stream.closed');
  };

  req.on('close', close);

  try {
    const db = await store.read();
    cursor = startingCursor(db.chainEvents || [], req, new URL(req.url, `http://${req.headers.host || 'localhost'}`));
    send(res, { type: 'hello', source: 'backend-events', cursor });
    unsubscribe = eventBus?.subscribe?.((event) => {
      if (!closed) sendEvent(event);
    }) || null;
  } catch (error) {
    send(res, { type: 'error', message: error?.message || String(error) });
  }

  pollTimer = setInterval(() => {
    if (closed || polling) return;
    polling = true;
    pollNewEvents()
      .catch((error) => send(res, { type: 'error', message: error?.message || String(error) }))
      .finally(() => { polling = false; });
  }, pollMs);

  heartbeatTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, DEFAULT_HEARTBEAT_MS);

  async function pollNewEvents() {
    const db = await store.read();
    const events = db.chainEvents || [];
    if (cursor > events.length) cursor = events.length;
    const next = events.slice(cursor);
    cursor = events.length;
    for (const event of next) sendEvent(event);
  }

  function sendEvent(event) {
    if (!event) return;
    if (event.id && sentIds.has(event.id)) return;
    if (event.id) {
      sentIds.add(event.id);
      if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value);
    }
    send(res, event, event.id);
  }
}

function startingCursor(events, req, url) {
  const replay = Number(url.searchParams.get('replay') || 0);
  if (Number.isFinite(replay) && replay > 0) {
    return Math.max(0, events.length - Math.min(500, replay));
  }

  const after = url.searchParams.get('after') || req.headers['last-event-id'];
  if (after) {
    const index = events.findIndex((event) => event.id === after);
    if (index !== -1) return index + 1;
  }

  return events.length;
}

function send(res, payload, id = null) {
  if (id) res.write(`id: ${String(id).replace(/[\r\n]/g, '')}\n`);
  res.write(`data: ${JSON.stringify(payload, bigintReplacer)}\n\n`);
}

function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
