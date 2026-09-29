'use strict';

// Shared bandwidth limiter. Every transfer of one direction calls take(bytes) before moving data, and
// callers are paced one after another, so the limit holds for all connections combined. The rate is read
// on every call, so changing it in Settings applies to transfers already running.

class Throttle {
  // getRate: () => bytes per second, 0 or less means unlimited
  constructor(getRate) {
    this.getRate = getRate;
    this.next = 0; // when the link is free again (ms epoch)
  }

  async take(bytes, signal) {
    const rate = this.getRate();
    if (!(rate > 0)) {
      this.next = 0;
      return;
    }
    const now = Date.now();
    const start = Math.max(this.next, now);
    this.next = start + (bytes / rate) * 1000;
    const wait = start - now;
    if (wait <= 0) return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    });
  }
}

module.exports = { Throttle };
