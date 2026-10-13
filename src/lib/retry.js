import { RETRYABLE_KINDS } from './errors.js';

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(fn, { retries = 3, baseDelayMs = 1000, maxDelayMs = 60000, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !RETRYABLE_KINDS.has(err?.kind)) throw err;
      await sleep(Math.min(err.retryAfterMs ?? baseDelayMs * 2 ** attempt, maxDelayMs));
    }
  }
}
