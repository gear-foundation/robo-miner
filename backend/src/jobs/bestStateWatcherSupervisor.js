const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export class BestStateWatcherSupervisor {
  constructor({
    startReader,
    logger = null,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (typeof startReader !== 'function') throw new Error('startReader is required');
    this.startReader = startReader;
    this.logger = logger;
    this.retryBaseMs = positiveInteger(retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = Math.max(this.retryBaseMs, positiveInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS));
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.reader = null;
    this.starting = null;
    this.retryTimer = null;
    this.failedAttempts = 0;
    this.stopped = false;
  }

  async ensureStarted() {
    if (this.stopped) return null;
    if (this.reader) return this.reader;
    if (this.starting) return this.starting;

    const attempt = this.failedAttempts + 1;
    this.starting = Promise.resolve()
      .then(() => this.startReader())
      .then(async (reader) => {
        if (!reader) throw new Error('No best-state programs available');
        if (this.stopped) {
          await reader.stop?.();
          return null;
        }
        this.reader = reader;
        this.failedAttempts = 0;
        this.cancelRetry();
        this.logger?.info?.('best_state.supervisor.ready', {
          attempt,
          subscriptions: reader.subscriptions?.size ?? null,
          programs: reader.programs?.length ?? null,
        });
        return reader;
      })
      .catch((error) => {
        this.failedAttempts = attempt;
        this.logger?.error?.('best_state.start.failed', {
          attempt,
          error: errorMessage(error),
          code: error?.code || null,
        });
        this.scheduleRetry();
        return null;
      })
      .finally(() => {
        this.starting = null;
      });

    return this.starting;
  }

  async addPrograms(programs = []) {
    const reader = await this.ensureStarted();
    return reader ? reader.addPrograms(programs) : [];
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const exponent = Math.max(0, this.failedAttempts - 1);
    const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    this.logger?.warn?.('best_state.start.retry_scheduled', {
      failedAttempts: this.failedAttempts,
      delayMs,
    });
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      void this.ensureStarted();
    }, delayMs);
  }

  cancelRetry() {
    if (!this.retryTimer) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  async stop() {
    this.stopped = true;
    this.cancelRetry();
    await this.starting?.catch(() => null);
    const reader = this.reader;
    this.reader = null;
    await reader?.stop?.();
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
