import { TranslationError } from './errors.js';
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
  failed: (what, detail) => `LM Studio で${what}できませんでした${detail ? `（${detail}）` : ''}`,
};

export function portOf(baseUrl) {
  const url = new URL(baseUrl);
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

async function isServerUp(baseUrl, fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function helperError(error, model) {
  switch (error?.kind) {
    case 'lms_not_found':
      return new TranslationError('config', MESSAGES.lmsNotFound);
    case 'model_not_found':
      return new TranslationError('config', MESSAGES.modelNotFound(model));
    case 'timeout':
      return new TranslationError('network', MESSAGES.timeout);
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
  if (!config.autoStart) return { started: false, loaded: false };
  const up = await isServerUp(config.baseUrl, fetch);
  onProgress(up ? 'モデルを読み込んでいます…' : 'LM Studio を起動しています…');

  const { reply, missing } = await callHelper(sendNativeMessage, { cmd: 'ensure', model: config.model, port: portOf(config.baseUrl) });
  if (missing) {
    // 補助プログラムがなくても、サーバーが動いていれば LM Studio の自動読み込み（JIT）に任せる
    if (up) return { started: false, loaded: false };
    throw new TranslationError('config', MESSAGES.helperMissing);
  }
  if (!reply?.ok) throw helperError(reply?.error, config.model);

  if (!up) {
    const deadline = now() + startWaitMs;
    while (!(await isServerUp(config.baseUrl, fetch))) {
      if (now() >= deadline) throw new TranslationError('network', MESSAGES.timeout);
      await sleep(POLL_INTERVAL_MS);
    }
  }
  return { started: Boolean(reply.started), loaded: Boolean(reply.loaded) };
}

export async function listLmStudioModels({ sendNativeMessage }) {
  const { reply, missing } = await callHelper(sendNativeMessage, { cmd: 'list' });
  if (missing) throw new TranslationError('config', MESSAGES.helperMissing);
  if (!reply?.ok) throw helperError(reply?.error, '');
  return reply.models;
}
