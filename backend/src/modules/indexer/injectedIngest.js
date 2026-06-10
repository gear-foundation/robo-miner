import { IndexerProjector } from './projector.js';

export class InjectedIngestService {
  constructor({ store, config, now = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.projector = new IndexerProjector({ store, config, now });
  }

  async ingest(payload) {
    const receivedAt = this.now().toISOString();
    const events = normalizeEvents(payload, receivedAt);
    const snapshots = normalizeSnapshots(payload, receivedAt);
    const [eventResults, snapshotResult] = await Promise.all([
      events.length ? this.projector.applyEvents(events) : [],
      snapshots.length ? this.projector.applySnapshots(snapshots) : { applied: 0 },
    ]);

    await this.store.update((db) => {
      db.jobRuns.push({
        id: `injected-ingest:${receivedAt}:${payload.receipt?.txHash || payload.txHash || events.length || snapshots.length}`,
        job: 'injected-ingest',
        mode: 'client-submitted',
        receivedAt,
        txHash: payload.receipt?.txHash || payload.txHash || null,
        messageId: payload.messageId || null,
        events: events.length,
        snapshots: snapshots.length,
      });
    });

    return {
      receivedAt,
      txHash: payload.receipt?.txHash || payload.txHash || null,
      events: eventResults.length,
      eventsApplied: eventResults.filter((result) => result.applied).length,
      snapshotsApplied: snapshotResult.applied,
    };
  }
}

function normalizeEvents(payload, receivedAt) {
  const input = payload.events || (payload.event ? [payload.event] : []);
  return input.map((event, index) => ({
    ...event,
    id: event.id || [
      payload.txHash || payload.receipt?.txHash || 'injected',
      payload.messageId || 'message',
      index,
      event.service || '',
      event.event || '',
    ].join(':'),
    source: event.source || 'injected-watch',
    txHash: event.txHash || payload.txHash || payload.receipt?.txHash || null,
    messageId: event.messageId || payload.messageId || null,
    timestamp: event.timestamp || receivedAt,
  }));
}

function normalizeSnapshots(payload, receivedAt) {
  const input = payload.snapshots || (payload.snapshot ? [payload.snapshot] : []);
  return input.map((snapshot) => ({
    ...snapshot,
    capturedAt: snapshot.capturedAt || receivedAt,
  }));
}
