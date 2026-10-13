import { TranslationError } from './errors.js';

export function buildSystemPrompt(targetLang) {
  return [
    `You are a professional translator. Translate each string in the "texts" array of the user's JSON into natural, fluent ${targetLang}.`,
    'Rules:',
    '- Strings may contain placeholder tags: <g0>…</g0> wraps inline markup such as links or bold text, <c0>…</c0> wraps inline code, and <x1/> stands for a standalone element.',
    '- Keep every placeholder tag exactly once and unchanged, moving it to the position that fits the translated word order.',
    '- Copy the content of <cN>…</cN> tags, URLs, file paths and code as is; do not translate them.',
    '- If a string is already in the target language or should not be translated (such as names), return it unchanged.',
    '- Return exactly one translation per input string, in the same order.',
    '- Respond with JSON only, in the form {"translations": ["...", "..."]}, with no explanations or code fences.',
  ].join('\n');
}

export function buildUserMessage(texts) {
  return JSON.stringify({ texts });
}

export function estimateMaxTokens(texts) {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return Math.min(16000, Math.max(2048, Math.ceil(chars * 1.5) + 1024));
}

const bad = (message) => new TranslationError('bad_response', `応答を解釈できません: ${message}`);

function findJson(s) {
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
  const start = useArray ? arrStart : objStart;
  const end = useArray ? s.lastIndexOf(']') : s.lastIndexOf('}');
  if (start < 0 || end < start) throw bad('JSONが見つかりません');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw bad('JSONを解析できません');
  }
}

export function parseTranslations(raw, expectedCount) {
  if (typeof raw !== 'string' || !raw.trim()) throw bad('応答が空です');
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');
  const parsed = findJson(cleaned);
  const list = Array.isArray(parsed) ? parsed : parsed?.translations;
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw bad('translations 配列がありません');
  if (list.length !== expectedCount) throw bad(`件数が一致しません (期待 ${expectedCount}, 実際 ${list.length})`);
  return list;
}
