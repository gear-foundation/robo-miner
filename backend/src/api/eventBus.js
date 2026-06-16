export class EventBus {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One broken SSE client must not block ingestion or other clients.
      }
    }
  }

  publishMany(events = []) {
    for (const event of events) this.publish(event);
  }
}
