import { TranslationError, isLocalUrl } from './errors.js';
import { defaultSleep } from './retry.js';

export const NATIVE_HOST = 'com.aipagetranslator.lmstudio';
const PROBE_TIMEOUT_MS = 2000;
const START_WAIT_MS = 90000;
const POLL_INTERVAL_MS = 1000;

const MESSAGES = {
  helperMissing: 'LM Studio を自動起動するには補助プログラムのインストールが必要です（設定画面に手順があります）。または LM Studio を起動してサーバーをオンにしてください',
  lmsNotFound: 'LM Studio が見つかりません。LM Studio をインストールし、一度起動してください',
  modelNotFound: (model) => `モデル ${model} が LM Studio にありません。設定画面でモデルを選び直してください`,
  timeout: 'LM Studio の起動（またはモデルの読み込み）に時間がかかっています。LM Studio の画面を確認してください',
  portMismatch: (running, wanted) => `LM Studio のサーバーはポート ${running} で動いています。設定のアドレスのポート（${wanted}）を ${running} に合わせてください`,
  failed: (what, detail) => `LM Studio で${what}できませんでした${detail ? `（${detail}）` : ''}`,
};

export function portOf(baseUrl) {
  const url = new URL(baseUrl);
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

/** サーバーの /models に問い合わせる。応答がなければ null */
async function fetchModels(baseUrl, fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: controller.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isServerUp(baseUrl, fetch) {
  return (await fetchModels(baseUrl, fetch)) != null;
}

/** 補助プログラムがなくても、サーバーが動いていればそこからモデル一覧を取る（埋め込み用モデルは除く） */
async function listModelsFromServer(baseUrl, fetch) {
  const res = baseUrl ? await fetchModels(baseUrl, fetch) : null;
  const ids = (await res?.json().catch(() => null))?.data?.map((m) => String(m?.id ?? '')) ?? null;
  return ids && ids.filter((id) => id && !/embed/i.test(id)).map((id) => ({ key: id, name: id }));
}

function helperError(error, model, port) {
  switch (error?.kind) {
    case 'lms_not_found':
      return new TranslationError('config', MESSAGES.lmsNotFound);
    case 'model_not_found':
      return new TranslationError('config', MESSAGES.modelNotFound(model));
    case 'timeout':
      return new TranslationError('network', MESSAGES.timeout);
    case 'port_mismatch':
      return new TranslationError('config', MESSAGES.portMismatch(error.running_port, port));
    case 'load_failed':
      return new TranslationError('config', MESSAGES.failed('モデルを読み込め', error.message));
    case 'start_failed':
      return new TranslationError('config', MESSAGES.failed('サーバーを起動', error.message));
    default:
      return new TranslationError('config', MESSAGES.failed('処理', error?.message || error?.kind));
  }
}

async function callHelper(sendNativeMessage, message) {
  try {
    return { reply: await sendNativeMessage(NATIVE_HOST, message) };
  } catch (err) {
    return { missing: true, detail: String(err?.message ?? err) };
  }
}

export async function ensureLmStudio(
  config,
  { fetch = globalThis.fetch, sendNativeMessage, sleep = defaultSleep, now = Date.now, onProgress = () => {}, startWaitMs = START_WAIT_MS } = {},
) {
  // 自動起動できるのはこのパソコンの LM Studio だけ（別のパソコンを指していれば手元では何もしない）
  if (!config.autoStart || !isLocalUrl(config.baseUrl)) return { started: false, loaded: false };
  const up = await isServerUp(config.baseUrl, fetch);
  onProgress(up ? 'モデルを読み込んでいます…' : 'LM Studio を起動しています…');

  const { reply, missing } = await callHelper(sendNativeMessage, { cmd: 'ensure', model: config.model, port: portOf(config.baseUrl) });
  if (missing) {
    // 補助プログラムがなくても、サーバーが動いていれば LM Studio の自動読み込み（JIT）に任せる
    if (up) return { started: false, loaded: false };
    throw new TranslationError('config', MESSAGES.helperMissing);
  }
  if (!reply?.ok) throw helperError(reply?.error, config.model, portOf(config.baseUrl));

  if (!up) {
    const deadline = now() + startWaitMs;
    while (!(await isServerUp(config.baseUrl, fetch))) {
      if (now() >= deadline) throw new TranslationError('network', MESSAGES.timeout);
      await sleep(POLL_INTERVAL_MS);
    }
  }
  return { started: Boolean(reply.started), loaded: Boolean(reply.loaded) };
}

export async function listLmStudioModels({ sendNativeMessage, baseUrl, fetch = globalThis.fetch }) {
  const { reply, missing } = await callHelper(sendNativeMessage, { cmd: 'list' });
  if (missing) {
    const models = await listModelsFromServer(baseUrl, fetch);
    if (models) return models;
    throw new TranslationError('config', MESSAGES.helperMissing);
  }
  if (!reply?.ok) throw helperError(reply?.error, '');
  return reply.models;
}

/** 同じキーの処理が実行中なら、新しく始めずにその結果を共有する（二重起動・二重読み込みを防ぐ） */
export function shareInFlight(fn, keyOf) {
  const running = new Map();
  return (...args) => {
    const key = keyOf(...args);
    if (running.has(key)) return running.get(key);
    const promise = (async () => fn(...args))().finally(() => running.delete(key));
    running.set(key, promise);
    return promise;
  };
}
