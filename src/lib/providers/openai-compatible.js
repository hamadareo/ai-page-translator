import { buildChatCompletionsRequest, extractChatCompletionsText } from './openai.js';

export const compatProvider = {
  buildRequest: (texts, targetLang, config) =>
    buildChatCompletionsRequest(texts, targetLang, {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      jsonMode: Boolean(config.jsonMode),
    }),
  extractText: extractChatCompletionsText,
};
