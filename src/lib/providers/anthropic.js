import { buildSystemPrompt, buildUserMessage, estimateMaxTokens } from '../prompt.js';
import { TranslationError } from '../errors.js';

const URL = 'https://api.anthropic.com/v1/messages';
/** サーバー側フォールバック（fallbacks: "default"）に対応するモデル */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
/** output_config.effort に対応するモデル */
const EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[5-8]|^claude-sonnet-4-6/;

export const anthropicProvider = {
  buildRequest(texts, targetLang, { apiKey, model }) {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const body = {
      model,
      max_tokens: estimateMaxTokens(texts),
      system: buildSystemPrompt(targetLang),
      messages: [{ role: 'user', content: buildUserMessage(texts) }],
    };
    if (EFFORT_MODELS.test(model)) body.output_config = { effort: 'low' };
    if (FALLBACK_MODELS.test(model)) {
      body.fallbacks = 'default';
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }
    return { url: URL, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  },

  extractText(json) {
    if (json?.stop_reason === 'refusal') throw new TranslationError('bad_response', 'モデルが翻訳を拒否しました');
    if (json?.stop_reason === 'max_tokens') throw new TranslationError('bad_response', '出力が上限で途切れました');
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new TranslationError('bad_response', '応答にテキストがありません');
    return text;
  },
};
