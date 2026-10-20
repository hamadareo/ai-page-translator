import { RETRYABLE_KINDS } from './errors.js';

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * レート制限を受けたら、同じ API へのほかのリクエストもいっせいに待たせる。
 * 1件ずつ制限にぶつかって再試行回数を使い切るのを防ぐ。
 */
export function createCooldown({ now = Date.now, sleep = defaultSleep } = {}) {
  let until = 0;
  return {
    pause(ms) {
      until = Math.max(until, now() + ms);
    },
    async wait() {
      while (now() < until) await sleep(until - now());
    },
  };
}

/** レート制限は待てば通るので、ほかのエラーより多めに再試行する */
const RATE_LIMIT_RETRIES = 8;

export async function withRetry(fn, { retries = 3, baseDelayMs = 1000, maxDelayMs = 60000, sleep = defaultSleep, cooldown, onWait } = {}) {
  for (let attempt = 0; ; attempt++) {
    await cooldown?.wait();
    try {
      return await fn();
    } catch (err) {
      const limit = err?.kind === 'rate_limit' ? Math.max(retries, RATE_LIMIT_RETRIES) : retries;
      if (attempt >= limit || !RETRYABLE_KINDS.has(err?.kind)) throw err;
      const delay = Math.min(err.retryAfterMs ?? baseDelayMs * 2 ** attempt, maxDelayMs);
      if (err.kind === 'rate_limit') onWait?.(delay);
      if (cooldown && err.kind === 'rate_limit') cooldown.pause(delay);
      else await sleep(delay);
    }
  }
}
