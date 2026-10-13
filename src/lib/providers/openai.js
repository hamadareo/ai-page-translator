import { buildSystemPrompt, buildUserMessage } from '../prompt.js';
import { TranslationError } from '../errors.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function buildChatCompletionsRequest(texts, targetLang, { apiKey, model, baseUrl, jsonMode }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(targetLang) },
      { role: 'user', content: buildUserMessage(texts) },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  };
}

export function extractChatCompletionsText(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new TranslationError('bad_response', '応答にテキストがありません');
  return content;
}

export const openaiProvider = {
  buildRequest: (texts, targetLang, config) =>
    buildChatCompletionsRequest(texts, targetLang, { apiKey: config.apiKey, model: config.model, baseUrl: OPENAI_BASE_URL, jsonMode: true }),
  extractText: extractChatCompletionsText,
};
