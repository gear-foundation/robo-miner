export class SerialJobQueue {
  constructor({ onSkipped = null } = {}) {
    this.onSkipped = onSkipped;
    this.pending = [];
    this.pendingNames = new Set();
    this.runningName = null;
    this.draining = null;
  }

  enqueue(name, fn) {
    if (this.runningName === name || this.pendingNames.has(name)) {
      this.onSkipped?.(name);
      return false;
    }

    this.pending.push({ name, fn });
    this.pendingNames.add(name);
    if (!this.draining) this.draining = this.drain();
    return true;
  }

  async drain() {
    try {
      while (this.pending.length > 0) {
        const { name, fn } = this.pending.shift();
        this.pendingNames.delete(name);
        this.runningName = name;
        try {
          await fn();
        } finally {
          this.runningName = null;
        }
      }
    } finally {
      this.draining = null;
      if (this.pending.length > 0) this.draining = this.drain();
    }
  }

  async idle() {
    await this.draining;
  }
}
