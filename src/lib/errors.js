/** @typedef {'auth'|'rate_limit'|'server'|'network'|'forbidden_local'|'bad_response'|'config'|'unknown'} ErrorKind */

export class TranslationError extends Error {
  /**
   * @param {ErrorKind} kind
   * @param {string} message
   * @param {{ retryAfterMs?: number }} [options]
   */
  constructor(kind, message, { retryAfterMs } = {}) {
    super(message);
    this.name = 'TranslationError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** これらが起きたらページ全体の翻訳を止める */
export const FATAL_KINDS = new Set(['auth', 'network', 'forbidden_local', 'config']);
/** これらはバックオフして再試行する */
export const RETRYABLE_KINDS = new Set(['rate_limit', 'server', 'network']);

export function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function parseRetryAfter(value) {
  if (value == null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function extractApiMessage(bodyText) {
  try {
    const json = JSON.parse(bodyText);
    const msg = json?.error?.message ?? json?.message ?? (typeof json?.error === 'string' ? json.error : '');
    return String(msg).slice(0, 200);
  } catch {
    return String(bodyText ?? '').slice(0, 200);
  }
}

export function classifyHttpError(status, bodyText, { url = '', retryAfter = null } = {}) {
  const detail = extractApiMessage(bodyText);
  const suffix = detail ? `（${detail}）` : '';
  if (status === 403 && isLocalUrl(url)) {
    return new TranslationError(
      'forbidden_local',
      `ローカルサーバーが拒否しました (403)。Ollama の場合は環境変数 OLLAMA_ORIGINS に chrome-extension://* を設定して再起動してください${suffix}`,
    );
  }
  if (status === 401 || status === 403) {
    return new TranslationError('auth', `APIキーを確認してください (${status})${suffix}`);
  }
  if (status === 429) {
    return new TranslationError('rate_limit', `レート制限に達しました (429)${suffix}`, {
      retryAfterMs: parseRetryAfter(retryAfter),
    });
  }
  if (status >= 500) return new TranslationError('server', `サーバーエラー (${status})${suffix}`);
  return new TranslationError('config', `リクエストが拒否されました (${status})。モデル名や設定を確認してください${suffix}`);
}

export function networkError(url) {
  return isLocalUrl(url)
    ? new TranslationError('network', 'ローカルLLMに接続できません。サーバーが起動しているか確認してください')
    : new TranslationError('network', 'ネットワークエラー: APIに接続できません');
}

export function toErrorPayload(err) {
  if (err instanceof TranslationError) return { kind: err.kind, message: err.message };
  return { kind: 'unknown', message: String(err?.message ?? err) };
}
