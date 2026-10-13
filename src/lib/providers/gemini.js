import { buildSystemPrompt, buildUserMessage } from '../prompt.js';
import { TranslationError } from '../errors.js';

export const geminiProvider = {
  buildRequest(texts, targetLang, { apiKey, model }) {
    const body = {
      systemInstruction: { parts: [{ text: buildSystemPrompt(targetLang) }] },
      contents: [{ role: 'user', parts: [{ text: buildUserMessage(texts) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    };
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      },
    };
  },

  extractText(json) {
    const candidate = json?.candidates?.[0];
    if (!candidate) {
      const reason = json?.promptFeedback?.blockReason ?? '不明';
      throw new TranslationError('bad_response', `応答がブロックされました (${reason})`);
    }
    if (candidate.finishReason === 'MAX_TOKENS') throw new TranslationError('bad_response', '出力が上限で途切れました');
    const parts = candidate.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!text) throw new TranslationError('bad_response', '応答にテキストがありません');
    return text;
  },
};
