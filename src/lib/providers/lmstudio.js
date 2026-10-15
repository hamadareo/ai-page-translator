import { buildChatCompletionsRequest, extractChatCompletionsText } from './openai.js';

export const lmstudioProvider = {
  buildRequest: (texts, targetLang, config) =>
    buildChatCompletionsRequest(texts, targetLang, {
      apiKey: '',
      model: config.model,
      baseUrl: config.baseUrl,
      jsonMode: false,
    }),
  extractText: extractChatCompletionsText,
};
