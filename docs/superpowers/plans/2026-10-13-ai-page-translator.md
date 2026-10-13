# AI Page Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成AI（OpenAI / Anthropic / Gemini / OpenAI互換・ローカルLLM）でWebページ全体を日本語などに置き換え翻訳する Chrome 拡張機能（Manifest V3）を作る。

**Architecture:** popup → content script（DOM 抽出・置換・監視）→ background service worker（キャッシュ・並列制御・リトライ・プロバイダ呼び出し）。ロジックはすべて `src/lib/` の `chrome.*` に依存しない純粋モジュールに置き、`node --test` + jsdom で単体テストする。`background.js` / `content.js` / popup / options は薄い配線のみ。

**Tech Stack:** Manifest V3, 素の JavaScript (ES Modules, ビルドなし), Node.js ≥ 20 の `node:test`, jsdom（devDependency のみ）

**Spec:** `docs/superpowers/specs/2026-10-13-ai-page-translator-design.md`

## Global Constraints

- Manifest V3。ビルド工程なし。ランタイム依存パッケージなし。`package.json` の依存は devDependency の `jsdom` のみ。
- テストは `npm test`（= `node --test test/*.test.js`）。Node.js ≥ 20.11（`import.meta.dirname` を使うため）。
- `src/lib/**` のモジュールは `chrome.*` を参照しない（参照してよいのは `src/background.js`, `src/content.js`, `src/popup/popup.js`, `src/options/options.js` のみ）。
- content script が動的 import するモジュール（`page-translator.js`, `status-overlay.js` とその依存）は `src/lib/` 直下に置く（`web_accessible_resources` が `src/lib/*.js`）。
- UI 文言は日本語。
- 既定値: provider `openai` / モデル `gpt-5.5`（OpenAI）, `claude-opus-5-5`（Anthropic）, `gemini-3.8-flash`（Gemini）, `llama3.2` + ベースURL `http://localhost:11434/v1`（OpenAI互換）/ targetLang `日本語` / バッチ 40 単位・3000 文字 / 並列 3 / キャッシュ 5000 件 / 動的コンテンツのデバウンス 500ms / リトライ最大3回（1s, 2s, 4s、`Retry-After` 優先、上限 60s）。
- Anthropic への直接呼び出しヘッダ: `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`。
- 拡張機能自身の状態表示要素の id は `apt-status-host`。
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける（各タスクのコミット手順に記載済み）。

## Review Focus

1. **フレームワークの再描画が訳文を上書きする**（React/Vue がテキストノードを書き換える）→ 書き換わった箇所は再翻訳され、例外にならない。テスト: Task 11「re-translates text the page rewrites after translation」。
2. **モデルが目印タグを落とす・重複させる** → その段落はテキストノード単位で訳し直され、リンク要素は保持される。テスト: Task 11「falls back to per-text-node translation when tags do not match」。
3. **APIキーを直して再度「翻訳」を押す** → 前回失敗した段落が再試行される（翻訳済み判定に失敗分が残らない）。テスト: Task 11「retries everything after a fatal error once translate is pressed again」。
4. **「原文に戻す」前にページが訳文の一部を削除した** → 残りは正しく復元され、例外にならない。テスト: Task 10「restoreAll tolerates content the page removed」。
5. **ページ本文に `<g0>` のような目印風の文字列が含まれる** → タグではなく文字として扱われ、そのまま表示される。テスト: Task 9「escapes literal tag-like text」と Task 10「keeps literal tag-like text as text」。

---

## File Structure

```
ai-page-translator/
├── manifest.json                    # Task 15
├── package.json / .gitignore        # Task 1
├── README.md                        # Task 15
├── docs/manual-test.md              # Task 15
├── src/
│   ├── background.js                # Task 8: メッセージ受付と配線
│   ├── content.js                   # Task 12: 注入・メッセージ受付・配線
│   ├── popup/popup.{html,js,css}    # Task 13
│   ├── options/options.{html,js,css}# Task 14
│   └── lib/
│       ├── errors.js                # Task 1: TranslationError, HTTP エラー分類
│       ├── settings.js              # Task 2: 既定値・マージ・検証・読み書き
│       ├── batch.js                 # Task 3: バッチ分割
│       ├── limiter.js               # Task 3: 同時実行数制限
│       ├── retry.js                 # Task 3: 指数バックオフ
│       ├── prompt.js                # Task 4: プロンプト生成・応答解析
│       ├── providers/
│       │   ├── openai.js            # Task 5: Chat Completions（OpenAI と互換の共通部）
│       │   ├── openai-compatible.js # Task 5
│       │   ├── anthropic.js         # Task 5
│       │   ├── gemini.js            # Task 5
│       │   └── index.js             # Task 5: callProvider
│       ├── cache.js                 # Task 6
│       ├── translate-service.js     # Task 7: キャッシュ + 分割再試行 + リトライ + 並列
│       ├── extract.js               # Task 9: DOM → 翻訳単位・目印付き文字列・解析
│       ├── rebuild.js               # Task 10: 訳文の反映・原文復元
│       ├── page-translator.js       # Task 11: ページ翻訳の進行管理・動的監視
│       └── status-overlay.js        # Task 12: ページ右下の状態表示
└── test/
    ├── helpers/{dom.js,fake-storage.js}
    └── *.test.js
```

---

### Task 1: プロジェクト雛形とエラー分類

**Files:**
- Create: `package.json`, `.gitignore`, `src/lib/errors.js`, `test/helpers/fake-storage.js`, `test/helpers/dom.js`
- Test: `test/errors.test.js`

**Interfaces:**
- Produces:
  - `class TranslationError extends Error { kind: ErrorKind; retryAfterMs?: number }`、`ErrorKind = 'auth'|'rate_limit'|'server'|'network'|'forbidden_local'|'bad_response'|'config'|'unknown'`
  - `FATAL_KINDS: Set<string>`（auth, network, forbidden_local, config）
  - `RETRYABLE_KINDS: Set<string>`（rate_limit, server, network）
  - `isLocalUrl(url: string): boolean`
  - `parseRetryAfter(value: string|null): number|undefined`（ms）
  - `classifyHttpError(status: number, bodyText: string, { url, retryAfter }): TranslationError`
  - `networkError(url: string): TranslationError`
  - `toErrorPayload(err): { kind: string, message: string }`
  - テスト補助: `createFakeStorage(initial?)`（`chrome.storage.local` 互換の `get/set/remove`）、`makeDocument(bodyHtml, { title })` → `{ window, document }`

- [ ] **Step 1: 雛形を作る**

```bash
cd ~/ai-page-translator
cat > package.json <<'EOF'
{
  "name": "ai-page-translator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js"
  }
}
EOF
printf 'node_modules/\n.DS_Store\n' > .gitignore
npm install --save-dev jsdom
mkdir -p src/lib/providers test/helpers
```

- [ ] **Step 2: テスト補助を書く**

`test/helpers/fake-storage.js`:
```js
export function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(key) {
      delete data[key];
    },
  };
}
```

`test/helpers/dom.js`:
```js
import { JSDOM } from 'jsdom';

export function makeDocument(bodyHtml, { title = '' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>${bodyHtml}</body></html>`,
  );
  return { window: dom.window, document: dom.window.document };
}
```

- [ ] **Step 3: 失敗するテストを書く**

`test/errors.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TranslationError, classifyHttpError, parseRetryAfter, isLocalUrl, networkError, toErrorPayload,
  FATAL_KINDS, RETRYABLE_KINDS,
} from '../src/lib/errors.js';

const CLOUD = 'https://api.openai.com/v1/chat/completions';
const LOCAL = 'http://localhost:11434/v1/chat/completions';

test('401 is auth and includes the API message', () => {
  const e = classifyHttpError(401, '{"error":{"message":"bad key"}}', { url: CLOUD });
  assert.ok(e instanceof TranslationError);
  assert.equal(e.kind, 'auth');
  assert.match(e.message, /APIキー/);
  assert.match(e.message, /bad key/);
});

test('403 on localhost is forbidden_local with OLLAMA_ORIGINS hint', () => {
  const e = classifyHttpError(403, '', { url: LOCAL });
  assert.equal(e.kind, 'forbidden_local');
  assert.match(e.message, /OLLAMA_ORIGINS/);
});

test('403 on a cloud API is auth', () => {
  assert.equal(classifyHttpError(403, '', { url: CLOUD }).kind, 'auth');
});

test('429 carries retryAfterMs from a seconds header', () => {
  const e = classifyHttpError(429, '', { url: CLOUD, retryAfter: '2' });
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterMs, 2000);
});

test('5xx is server, other 4xx is config', () => {
  assert.equal(classifyHttpError(503, '', { url: CLOUD }).kind, 'server');
  assert.equal(classifyHttpError(404, '{"error":{"message":"model not found"}}', { url: CLOUD }).kind, 'config');
  assert.equal(classifyHttpError(400, 'plain text body', { url: CLOUD }).message.includes('plain text body'), true);
});

test('parseRetryAfter handles seconds, HTTP dates and garbage', () => {
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
  const ms = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
  assert.ok(ms > 3000 && ms <= 5000, `got ${ms}`);
});

test('isLocalUrl', () => {
  assert.equal(isLocalUrl('http://localhost:1234/v1'), true);
  assert.equal(isLocalUrl('http://127.0.0.1:1234/v1'), true);
  assert.equal(isLocalUrl('https://openrouter.ai/api/v1'), false);
  assert.equal(isLocalUrl('not a url'), false);
});

test('networkError message depends on locality', () => {
  assert.match(networkError(LOCAL).message, /起動/);
  assert.equal(networkError(LOCAL).kind, 'network');
  assert.doesNotMatch(networkError(CLOUD).message, /起動/);
});

test('toErrorPayload serializes known and unknown errors', () => {
  assert.deepEqual(toErrorPayload(new TranslationError('auth', 'x')), { kind: 'auth', message: 'x' });
  assert.deepEqual(toErrorPayload(new Error('boom')), { kind: 'unknown', message: 'boom' });
});

test('kind sets', () => {
  assert.deepEqual([...FATAL_KINDS].sort(), ['auth', 'config', 'forbidden_local', 'network']);
  assert.deepEqual([...RETRYABLE_KINDS].sort(), ['network', 'rate_limit', 'server']);
});
```

- [ ] **Step 4: 失敗を確認**

Run: `npm test`
Expected: FAIL（`Cannot find module .../src/lib/errors.js`）

- [ ] **Step 5: 実装する**

`src/lib/errors.js`:
```js
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
```

- [ ] **Step 6: 成功を確認**

Run: `npm test`
Expected: PASS（10 tests）

- [ ] **Step 7: コミット**

```bash
git add package.json package-lock.json .gitignore src/lib/errors.js test/
git commit -m "feat: scaffold project and add error classification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 設定（既定値・マージ・検証・読み書き）

**Files:**
- Create: `src/lib/settings.js`
- Test: `test/settings.test.js`

**Interfaces:**
- Consumes: `createFakeStorage`（Task 1）
- Produces:
  - `PROVIDER_IDS = ['openai','anthropic','gemini','compat']`, `PROVIDER_LABELS: Record<id, string>`
  - `DEFAULT_SETTINGS`（形は下記）、`SETTINGS_KEY = 'settings'`
  - `mergeSettings(stored?): Settings`（既定値に深くマージした新しいオブジェクト）
  - `validateSettings(s): string|null`（エラーメッセージまたは null）
  - `loadSettings(storage): Promise<Settings>`, `saveSettings(storage, s): Promise<void>`
  - `Settings = { provider, targetLang, maxUnitsPerBatch, maxCharsPerBatch, concurrency, providers: { openai:{apiKey,model}, anthropic:{apiKey,model}, gemini:{apiKey,model}, compat:{apiKey,model,baseUrl,jsonMode} } }`

- [ ] **Step 1: 失敗するテストを書く**

`test/settings.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, PROVIDER_IDS, PROVIDER_LABELS, mergeSettings, validateSettings, loadSettings, saveSettings, SETTINGS_KEY,
} from '../src/lib/settings.js';
import { createFakeStorage } from './helpers/fake-storage.js';

test('defaults match the spec', () => {
  const s = mergeSettings(undefined);
  assert.equal(s.provider, 'openai');
  assert.equal(s.targetLang, '日本語');
  assert.equal(s.maxUnitsPerBatch, 40);
  assert.equal(s.maxCharsPerBatch, 3000);
  assert.equal(s.concurrency, 3);
  assert.equal(s.providers.openai.model, 'gpt-5.5');
  assert.equal(s.providers.anthropic.model, 'claude-opus-5-5');
  assert.equal(s.providers.gemini.model, 'gemini-3.8-flash');
  assert.deepEqual(s.providers.compat, { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', jsonMode: false });
  assert.deepEqual(PROVIDER_IDS, ['openai', 'anthropic', 'gemini', 'compat']);
  for (const id of PROVIDER_IDS) assert.equal(typeof PROVIDER_LABELS[id], 'string');
});

test('mergeSettings keeps defaults for missing nested keys and does not share objects', () => {
  const s = mergeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k' } } });
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.providers.anthropic.apiKey, 'k');
  assert.equal(s.providers.anthropic.model, 'claude-opus-5-5');
  s.providers.openai.apiKey = 'mutated';
  assert.equal(DEFAULT_SETTINGS.providers.openai.apiKey, '');
});

test('validateSettings', () => {
  const ok = mergeSettings({ providers: { openai: { apiKey: 'k' } } });
  assert.equal(validateSettings(ok), null);
  assert.match(validateSettings(mergeSettings({})), /APIキー/);
  assert.match(validateSettings(mergeSettings({ providers: { openai: { apiKey: 'k', model: ' ' } } })), /モデル/);
  assert.match(validateSettings(mergeSettings({ provider: 'nope' })), /プロバイダ/);
  assert.equal(validateSettings(mergeSettings({ provider: 'compat' })), null, 'compat needs no key');
  assert.match(validateSettings(mergeSettings({ provider: 'compat', providers: { compat: { baseUrl: 'ftp://x' } } })), /ベースURL/);
  assert.match(validateSettings(mergeSettings({ provider: 'compat', providers: { compat: { baseUrl: 'nonsense' } } })), /ベースURL/);
  assert.match(validateSettings(mergeSettings({ provider: 'compat', targetLang: '' })), /翻訳先言語/);
  assert.match(validateSettings(mergeSettings({ provider: 'compat', concurrency: 0 })), /同時/);
});

test('load and save round-trip through storage', async () => {
  const storage = createFakeStorage();
  assert.deepEqual(await loadSettings(storage), mergeSettings(undefined));
  const s = mergeSettings({ provider: 'gemini', providers: { gemini: { apiKey: 'g' } } });
  await saveSettings(storage, s);
  assert.deepEqual(storage.data[SETTINGS_KEY], s);
  assert.deepEqual(await loadSettings(storage), s);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`settings.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/settings.js`:
```js
export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'compat'];

export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  compat: 'OpenAI互換 / ローカルLLM',
};

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  targetLang: '日本語',
  maxUnitsPerBatch: 40,
  maxCharsPerBatch: 3000,
  concurrency: 3,
  providers: {
    openai: { apiKey: '', model: 'gpt-5.5' },
    anthropic: { apiKey: '', model: 'claude-opus-5-5' },
    gemini: { apiKey: '', model: 'gemini-3.8-flash' },
    compat: { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', jsonMode: false },
  },
};

export function mergeSettings(stored) {
  const s = stored ?? {};
  const providers = {};
  for (const id of PROVIDER_IDS) {
    providers[id] = { ...DEFAULT_SETTINGS.providers[id], ...(s.providers?.[id] ?? {}) };
  }
  return { ...DEFAULT_SETTINGS, ...s, providers };
}

/** @returns {string|null} */
export function validateSettings(s) {
  if (!PROVIDER_IDS.includes(s.provider)) return 'プロバイダが不正です';
  const p = s.providers[s.provider];
  if (!p.model?.trim()) return 'モデル名を設定してください';
  if (s.provider !== 'compat' && !p.apiKey?.trim()) return 'APIキーを設定してください';
  if (s.provider === 'compat') {
    let url;
    try {
      url = new URL(p.baseUrl);
    } catch {
      return 'ベースURLが不正です';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ベースURLが不正です';
  }
  if (!s.targetLang?.trim()) return '翻訳先言語を設定してください';
  if (!(s.maxUnitsPerBatch >= 1) || !(s.maxCharsPerBatch >= 1)) return 'バッチ上限が不正です';
  if (!(s.concurrency >= 1)) return '同時リクエスト数は1以上にしてください';
  return null;
}

export async function loadSettings(storage) {
  const result = await storage.get(SETTINGS_KEY);
  return mergeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(storage, settings) {
  await storage.set({ [SETTINGS_KEY]: settings });
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/settings.js test/settings.test.js
git commit -m "feat: add settings defaults, merge and validation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 流量制御ユーティリティ（バッチ分割・同時実行制限・リトライ）

**Files:**
- Create: `src/lib/batch.js`, `src/lib/limiter.js`, `src/lib/retry.js`
- Test: `test/batch.test.js`, `test/limiter.test.js`, `test/retry.test.js`

**Interfaces:**
- Consumes: `RETRYABLE_KINDS`, `TranslationError`（Task 1）
- Produces:
  - `makeBatches(texts: string[], { maxUnits, maxChars }): number[][]`（インデックスの配列の配列。上限超過の単一要素は単独バッチ）
  - `createLimiter(max: number): { run<T>(fn: () => Promise<T>): Promise<T>, setMax(n: number): void, readonly active: number }`
  - `withRetry<T>(fn: () => Promise<T>, { retries = 3, baseDelayMs = 1000, maxDelayMs = 60000, sleep }): Promise<T>`
  - `defaultSleep(ms): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`test/batch.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBatches } from '../src/lib/batch.js';

test('splits by unit count', () => {
  assert.deepEqual(makeBatches(['a', 'b', 'c', 'd', 'e'], { maxUnits: 2, maxChars: 1000 }), [[0, 1], [2, 3], [4]]);
});

test('splits by character count', () => {
  assert.deepEqual(makeBatches(['aaaa', 'bbbb', 'cc'], { maxUnits: 10, maxChars: 6 }), [[0], [1, 2]]);
});

test('an oversized single text gets its own batch', () => {
  assert.deepEqual(makeBatches(['x'.repeat(50), 'y', 'z'], { maxUnits: 10, maxChars: 10 }), [[0], [1, 2]]);
});

test('empty input gives no batches', () => {
  assert.deepEqual(makeBatches([], { maxUnits: 10, maxChars: 10 }), []);
});
```

`test/limiter.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/lib/limiter.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('never runs more than max tasks at once and returns results', async () => {
  const limiter = createLimiter(2);
  let running = 0;
  let peak = 0;
  const task = (v) => limiter.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
    return v;
  });
  const results = await Promise.all([1, 2, 3, 4, 5].map(task));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.equal(limiter.active, 0);
});

test('propagates rejections and keeps going', async () => {
  const limiter = createLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('x'); }), /x/);
  assert.equal(await limiter.run(async () => 7), 7);
});

test('setMax raises concurrency for queued work', async () => {
  const limiter = createLimiter(1);
  let peak = 0;
  let running = 0;
  const jobs = [1, 2, 3].map(() => limiter.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
  }));
  limiter.setMax(3);
  await Promise.all(jobs);
  assert.equal(peak, 3);
});
```

`test/retry.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/lib/retry.js';
import { TranslationError } from '../src/lib/errors.js';

test('retries retryable errors with exponential backoff', async () => {
  const delays = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new TranslationError('server', 'x');
    return 'ok';
  }, { sleep: async (ms) => delays.push(ms) });
  assert.equal(result, 'ok');
  assert.deepEqual(delays, [1000, 2000]);
});

test('uses retryAfterMs when present, capped at maxDelayMs', async () => {
  const delays = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls === 1) throw new TranslationError('rate_limit', 'x', { retryAfterMs: 5000 });
    if (calls === 2) throw new TranslationError('rate_limit', 'x', { retryAfterMs: 999999 });
    return 'ok';
  }, { sleep: async (ms) => delays.push(ms) });
  assert.deepEqual(delays, [5000, 60000]);
});

test('gives up after the retry limit', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new TranslationError('network', 'down'); }, { sleep: async () => {} }),
    /down/,
  );
  assert.equal(calls, 4);
});

test('does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new TranslationError('auth', 'nope'); }, { sleep: async () => {} }),
    /nope/,
  );
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（3モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/lib/batch.js`:
```js
/**
 * テキストを件数・文字数の上限でバッチに分ける。
 * @returns {number[][]} 各バッチに含まれる texts のインデックス
 */
export function makeBatches(texts, { maxUnits, maxChars }) {
  const batches = [];
  let current = [];
  let chars = 0;
  texts.forEach((text, i) => {
    if (current.length && (current.length >= maxUnits || chars + text.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(i);
    chars += text.length;
  });
  if (current.length) batches.push(current);
  return batches;
}
```

`src/lib/limiter.js`:
```js
export function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    setMax(n) {
      max = Math.max(1, Math.floor(n) || 1);
      next();
    },
    get active() {
      return active;
    },
  };
}
```

`src/lib/retry.js`:
```js
import { RETRYABLE_KINDS } from './errors.js';

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(fn, { retries = 3, baseDelayMs = 1000, maxDelayMs = 60000, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !RETRYABLE_KINDS.has(err?.kind)) throw err;
      await sleep(Math.min(err.retryAfterMs ?? baseDelayMs * 2 ** attempt, maxDelayMs));
    }
  }
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/batch.js src/lib/limiter.js src/lib/retry.js test/batch.test.js test/limiter.test.js test/retry.test.js
git commit -m "feat: add batching, concurrency limiter and retry helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: プロンプト生成と応答解析

**Files:**
- Create: `src/lib/prompt.js`
- Test: `test/prompt.test.js`

**Interfaces:**
- Consumes: `TranslationError`（Task 1）
- Produces:
  - `buildSystemPrompt(targetLang: string): string`
  - `buildUserMessage(texts: string[]): string`（`{"texts":[...]}`）
  - `parseTranslations(raw: string, expectedCount: number): string[]`（失敗時 `TranslationError('bad_response')`）
  - `estimateMaxTokens(texts: string[]): number`（2048〜16000）

目印タグの約束（Task 9 と共有）: `<gN>…</gN>` = インライン要素、`<cN>…</cN>` = コード系インライン要素（中身を訳さない）、`<xN/>` = 単独要素。

- [ ] **Step 1: 失敗するテストを書く**

`test/prompt.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildUserMessage, parseTranslations, estimateMaxTokens } from '../src/lib/prompt.js';

test('system prompt mentions the language, the tags and JSON', () => {
  const p = buildSystemPrompt('日本語');
  assert.match(p, /日本語/);
  assert.match(p, /<g0>/);
  assert.match(p, /<c0>/);
  assert.match(p, /<x1\/>/);
  assert.match(p, /JSON/);
  assert.match(p, /"translations"/);
});

test('user message is JSON with texts', () => {
  assert.deepEqual(JSON.parse(buildUserMessage(['a', 'b'])), { texts: ['a', 'b'] });
});

const bad = { name: 'TranslationError', kind: 'bad_response' };

test('parses plain, fenced, prefaced and <think> responses', () => {
  assert.deepEqual(parseTranslations('{"translations":["あ","い"]}', 2), ['あ', 'い']);
  assert.deepEqual(parseTranslations('```json\n{"translations":["あ"]}\n```', 1), ['あ']);
  assert.deepEqual(parseTranslations('Here you go:\n{"translations":["あ"]}\nThanks', 1), ['あ']);
  assert.deepEqual(parseTranslations('<think>{maybe}</think>{"translations":["あ"]}', 1), ['あ']);
});

test('accepts a bare array', () => {
  assert.deepEqual(parseTranslations('["あ","い"]', 2), ['あ', 'い']);
});

test('rejects count mismatch, non-strings and garbage', () => {
  assert.throws(() => parseTranslations('{"translations":["あ"]}', 2), bad);
  assert.throws(() => parseTranslations('{"translations":[1]}', 1), bad);
  assert.throws(() => parseTranslations('no json here', 1), bad);
  assert.throws(() => parseTranslations('{"translations": [', 1), bad);
  assert.throws(() => parseTranslations(undefined, 1), bad);
});

test('estimateMaxTokens stays within bounds', () => {
  assert.equal(estimateMaxTokens(['']), 2048);
  assert.equal(estimateMaxTokens(['x'.repeat(100000)]), 16000);
  assert.equal(estimateMaxTokens(['x'.repeat(2000)]), 4024);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`prompt.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/prompt.js`:
```js
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
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/prompt.js test/prompt.test.js
git commit -m "feat: add translation prompt and response parser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: プロバイダ（OpenAI / OpenAI互換 / Anthropic / Gemini）と `callProvider`

**Files:**
- Create: `src/lib/providers/openai.js`, `src/lib/providers/openai-compatible.js`, `src/lib/providers/anthropic.js`, `src/lib/providers/gemini.js`, `src/lib/providers/index.js`
- Test: `test/providers.test.js`

**Interfaces:**
- Consumes: `buildSystemPrompt`, `buildUserMessage`, `parseTranslations`, `estimateMaxTokens`（Task 4）; `TranslationError`, `classifyHttpError`, `networkError`（Task 1）
- Produces:
  - 各プロバイダ `{ buildRequest(texts, targetLang, config): { url: string, init: RequestInit }, extractText(json): string }`
    - `openaiProvider`, `compatProvider`, `anthropicProvider`, `geminiProvider`
  - `PROVIDERS: Record<'openai'|'anthropic'|'gemini'|'compat', Provider>`
  - `callProvider(providerId, texts, targetLang, config, { fetch?, signal? }): Promise<string[]>`

Anthropic: Claude Opus 5.5 / Opus 5 / Fable 5.1 / Sonnet 5.5 には `fallbacks: "default"` + `anthropic-beta: server-side-fallback-2026-07-01` を付ける（拒否時にサーバー側で別モデルへ回す）。effort 対応モデルには `output_config: { effort: "low" }`（翻訳は深い推論不要）。`temperature` は送らない（現行モデルでは 400）。

- [ ] **Step 1: 失敗するテストを書く**

`test/providers.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, callProvider } from '../src/lib/providers/index.js';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(responder) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, init);
  };
  fetch.calls = calls;
  return fetch;
}

const chat = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

test('openai request shape', () => {
  const { url, init } = PROVIDERS.openai.buildRequest(['Hi'], '日本語', { apiKey: 'sk', model: 'gpt-5.5' });
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer sk');
  assert.equal(body.model, 'gpt-5.5');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /日本語/);
  assert.deepEqual(JSON.parse(body.messages[1].content), { texts: ['Hi'] });
  assert.equal('temperature' in body, false);
});

test('compat request uses baseUrl, optional key and optional json mode', () => {
  const a = PROVIDERS.compat.buildRequest(['Hi'], '日本語', { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1/', jsonMode: false });
  assert.equal(a.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in a.init.headers, false);
  assert.equal('response_format' in JSON.parse(a.init.body), false);
  const b = PROVIDERS.compat.buildRequest(['Hi'], '日本語', { apiKey: 'or', model: 'm', baseUrl: 'https://openrouter.ai/api/v1', jsonMode: true });
  assert.equal(b.init.headers.Authorization, 'Bearer or');
  assert.deepEqual(JSON.parse(b.init.body).response_format, { type: 'json_object' });
});

test('chat completions text extraction', () => {
  assert.equal(PROVIDERS.openai.extractText(chat('x')), 'x');
  assert.throws(() => PROVIDERS.openai.extractText({}), { kind: 'bad_response' });
});

test('anthropic request shape for Claude Opus 5.5', () => {
  const { url, init } = PROVIDERS.anthropic.buildRequest(['Hi'], '日本語', { apiKey: 'ak', model: 'claude-opus-5-5' });
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'ak');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(typeof body.max_tokens, 'number');
  assert.match(body.system, /日本語/);
  assert.deepEqual(body.messages, [{ role: 'user', content: '{"texts":["Hi"]}' }]);
  assert.equal('temperature' in body, false);
});

test('anthropic omits fallbacks and effort for models without them', () => {
  const haiku55 = JSON.parse(PROVIDERS.anthropic.buildRequest(['Hi'], 'ja', { apiKey: 'k', model: 'claude-haiku-5-5' }).init.body);
  assert.equal('fallbacks' in haiku55, false);
  assert.deepEqual(haiku55.output_config, { effort: 'low' });
  const { init } = PROVIDERS.anthropic.buildRequest(['Hi'], 'ja', { apiKey: 'k', model: 'claude-haiku-4-5' });
  const haiku45 = JSON.parse(init.body);
  assert.equal('fallbacks' in haiku45, false);
  assert.equal('output_config' in haiku45, false);
  assert.equal('anthropic-beta' in init.headers, false);
});

test('anthropic extraction joins text blocks and rejects refusals and truncation', () => {
  const ok = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"tr' }, { type: 'text', text: 'anslations":[]}' }] };
  assert.equal(PROVIDERS.anthropic.extractText(ok), '{"translations":[]}');
  assert.throws(() => PROVIDERS.anthropic.extractText({ stop_reason: 'refusal', content: [] }), { kind: 'bad_response' });
  assert.throws(() => PROVIDERS.anthropic.extractText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }), { kind: 'bad_response' });
});

test('gemini request shape and extraction', () => {
  const { url, init } = PROVIDERS.gemini.buildRequest(['Hi'], '日本語', { apiKey: 'gk', model: 'gemini-3.8-flash' });
  const body = JSON.parse(init.body);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(init.headers['x-goog-api-key'], 'gk');
  assert.match(body.systemInstruction.parts[0].text, /日本語/);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '{"texts":["Hi"]}' }] }]);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  const resp = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'a', thought: true }, { text: 'b' }, { text: 'c' }] } }] };
  assert.equal(PROVIDERS.gemini.extractText(resp), 'bc');
  assert.throws(() => PROVIDERS.gemini.extractText({ promptFeedback: { blockReason: 'SAFETY' } }), { kind: 'bad_response' });
  assert.throws(() => PROVIDERS.gemini.extractText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }), { kind: 'bad_response' });
});

test('callProvider returns parsed translations', async () => {
  const fetch = fakeFetch(() => json(chat('{"translations":["こんにちは"]}')));
  const out = await callProvider('openai', ['Hello'], '日本語', { apiKey: 'k', model: 'm' }, { fetch });
  assert.deepEqual(out, ['こんにちは']);
  assert.equal(fetch.calls.length, 1);
});

test('callProvider maps HTTP errors, network failures and bad JSON', async () => {
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => json({ error: { message: 'bad' } }, 401)) }),
    { kind: 'auth' },
  );
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => json({}, 429, { 'retry-after': '3' })) }),
    (e) => e.kind === 'rate_limit' && e.retryAfterMs === 3000,
  );
  await assert.rejects(
    callProvider('compat', ['a'], 'ja', { model: 'm', baseUrl: 'http://localhost:11434/v1' }, { fetch: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e.kind === 'network' && /起動/.test(e.message),
  );
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => new Response('<html>', { status: 200 })) }),
    { kind: 'bad_response' },
  );
  await assert.rejects(
    callProvider('openai', ['a', 'b'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: fakeFetch(() => json(chat('{"translations":["x"]}'))) }),
    { kind: 'bad_response' },
  );
  await assert.rejects(callProvider('nope', ['a'], 'ja', {}, { fetch: fakeFetch(() => json({})) }), { kind: 'config' });
});

test('callProvider rethrows aborts untouched', async () => {
  const abort = new DOMException('aborted', 'AbortError');
  await assert.rejects(
    callProvider('openai', ['a'], 'ja', { apiKey: 'k', model: 'm' }, { fetch: async () => { throw abort; } }),
    (e) => e === abort,
  );
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`providers/index.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/providers/openai.js`:
```js
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
```

`src/lib/providers/openai-compatible.js`:
```js
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
```

`src/lib/providers/anthropic.js`:
```js
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
```

`src/lib/providers/gemini.js`:
```js
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
```

`src/lib/providers/index.js`:
```js
import { openaiProvider } from './openai.js';
import { compatProvider } from './openai-compatible.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { parseTranslations } from '../prompt.js';
import { TranslationError, classifyHttpError, networkError } from '../errors.js';

export const PROVIDERS = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  compat: compatProvider,
};

/** @returns {Promise<string[]>} */
export async function callProvider(providerId, texts, targetLang, config, { fetch = globalThis.fetch, signal } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new TranslationError('config', `未対応のプロバイダです: ${providerId}`);
  const { url, init } = provider.buildRequest(texts, targetLang, config);

  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw networkError(url);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw classifyHttpError(res.status, body, { url, retryAfter: res.headers.get('retry-after') });
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new TranslationError('bad_response', '応答がJSONではありません');
  }
  return parseTranslations(provider.extractText(json), texts.length);
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/providers test/providers.test.js
git commit -m "feat: add OpenAI, compatible, Anthropic and Gemini providers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 翻訳キャッシュ

**Files:**
- Create: `src/lib/cache.js`
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: `createFakeStorage`（Task 1）
- Produces:
  - `cacheKey(provider, model, targetLang, text): Promise<string>`（SHA-256 16進）
  - `CACHE_KEY = 'translationCache'`
  - `createCache(storage, { maxEntries = 5000, now = Date.now }): { getMany(keys): Promise<(string|undefined)[]>, setMany(entries: {key,value}[]): Promise<void>, clear(): Promise<void>, size(): Promise<number> }`

- [ ] **Step 1: 失敗するテストを書く**

`test/cache.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, createCache, CACHE_KEY } from '../src/lib/cache.js';
import { createFakeStorage } from './helpers/fake-storage.js';

test('cacheKey is deterministic and depends on every part', async () => {
  const a = await cacheKey('openai', 'm', 'ja', 'Hello');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await cacheKey('openai', 'm', 'ja', 'Hello'));
  assert.notEqual(a, await cacheKey('openai', 'm2', 'ja', 'Hello'));
  assert.notEqual(a, await cacheKey('anthropic', 'm', 'ja', 'Hello'));
  assert.notEqual(a, await cacheKey('openai', 'm', 'en', 'Hello'));
  assert.notEqual(a, await cacheKey('openai', 'm', 'ja', 'Hello!'));
});

test('stores, reads back and persists across instances', async () => {
  const storage = createFakeStorage();
  const cache = createCache(storage);
  await cache.setMany([{ key: 'a', value: 'あ' }]);
  assert.deepEqual(await cache.getMany(['a', 'b']), ['あ', undefined]);
  const again = createCache(storage);
  assert.deepEqual(await again.getMany(['a']), ['あ']);
  assert.ok(storage.data[CACHE_KEY].a);
});

test('evicts least recently used entries beyond maxEntries', async () => {
  let t = 0;
  const cache = createCache(createFakeStorage(), { maxEntries: 2, now: () => ++t });
  await cache.setMany([{ key: 'a', value: '1' }]);
  await cache.setMany([{ key: 'b', value: '2' }]);
  await cache.getMany(['a']); // a を最近使ったことにする
  await cache.setMany([{ key: 'c', value: '3' }]);
  assert.equal(await cache.size(), 2);
  assert.deepEqual(await cache.getMany(['a', 'b', 'c']), ['1', undefined, '3']);
});

test('clear empties memory and storage', async () => {
  const storage = createFakeStorage();
  const cache = createCache(storage);
  await cache.setMany([{ key: 'a', value: '1' }]);
  await cache.clear();
  assert.deepEqual(await cache.getMany(['a']), [undefined]);
  assert.equal(CACHE_KEY in storage.data, false);
});

test('concurrent first reads load storage once', async () => {
  const storage = createFakeStorage({ [CACHE_KEY]: { a: { v: '1', t: 0 } } });
  let gets = 0;
  const original = storage.get;
  storage.get = async (k) => { gets++; return original(k); };
  const cache = createCache(storage);
  await Promise.all([cache.getMany(['a']), cache.getMany(['a'])]);
  assert.equal(gets, 1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`cache.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/cache.js`:
```js
export const CACHE_KEY = 'translationCache';

export async function cacheKey(provider, model, targetLang, text) {
  const data = new TextEncoder().encode(`${provider}|${model}|${targetLang}|${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 値は { v: 訳文, t: 最終利用時刻 } として1つのオブジェクトにまとめて保存する */
export function createCache(storage, { maxEntries = 5000, now = Date.now } = {}) {
  let loading = null;

  const load = () => {
    loading ??= storage.get(CACHE_KEY).then((r) => new Map(Object.entries(r[CACHE_KEY] ?? {})));
    return loading;
  };

  return {
    async getMany(keys) {
      const map = await load();
      const t = now();
      return keys.map((k) => {
        const entry = map.get(k);
        if (!entry) return undefined;
        entry.t = t;
        return entry.v;
      });
    },

    async setMany(entries) {
      const map = await load();
      const t = now();
      for (const { key, value } of entries) map.set(key, { v: value, t });
      if (map.size > maxEntries) {
        const oldest = [...map.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, map.size - maxEntries);
        for (const [k] of oldest) map.delete(k);
      }
      await storage.set({ [CACHE_KEY]: Object.fromEntries(map) });
    },

    async clear() {
      loading = Promise.resolve(new Map());
      await storage.remove(CACHE_KEY);
    },

    async size() {
      return (await load()).size;
    },
  };
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/cache.js test/cache.test.js
git commit -m "feat: add LRU translation cache" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 翻訳サービス（キャッシュ + 分割再依頼 + リトライ + 並列制御）

**Files:**
- Create: `src/lib/translate-service.js`
- Test: `test/translate-service.test.js`

**Interfaces:**
- Consumes: `cacheKey`, `createCache`（Task 6）; `callProvider`（Task 5）; `withRetry`（Task 3）; `createLimiter`（Task 3）; `validateSettings`, `mergeSettings`（Task 2）; `TranslationError`（Task 1）
- Produces:
  - `translateWithSplit(texts, translateOnce: (texts) => Promise<string[]>): Promise<(string|null)[]>`（`bad_response` のとき半分に分けて再依頼、1件でも失敗なら `null`）
  - `createTranslateService({ getSettings, cache, limiter, call = callProvider, fetch, sleep }): (texts: string[]) => Promise<(string|null)[]>`
    - 設定不正なら `TranslationError('config')` を投げる。致命的エラーはそのまま投げる。

- [ ] **Step 1: 失敗するテストを書く**

`test/translate-service.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslateService, translateWithSplit } from '../src/lib/translate-service.js';
import { createCache } from '../src/lib/cache.js';
import { createLimiter } from '../src/lib/limiter.js';
import { mergeSettings } from '../src/lib/settings.js';
import { TranslationError } from '../src/lib/errors.js';
import { createFakeStorage } from './helpers/fake-storage.js';

const settings = mergeSettings({ providers: { openai: { apiKey: 'k' } } });

function setup(call, s = settings) {
  const calls = [];
  const wrapped = async (...args) => { calls.push(args[1]); return call(...args); };
  const translate = createTranslateService({
    getSettings: async () => s,
    cache: createCache(createFakeStorage()),
    limiter: createLimiter(3),
    call: wrapped,
    sleep: async () => {},
  });
  return { translate, calls };
}

const upper = async (_p, texts) => texts.map((t) => t.toUpperCase());

test('passes provider, language and config to the call', async () => {
  let seen;
  const { translate } = setup(async (provider, texts, lang, config) => {
    seen = { provider, lang, config };
    return texts;
  });
  await translate(['a']);
  assert.deepEqual(seen, { provider: 'openai', lang: '日本語', config: settings.providers.openai });
});

test('uses the cache for repeated texts', async () => {
  const { translate, calls } = setup(upper);
  assert.deepEqual(await translate(['a', 'b']), ['A', 'B']);
  assert.deepEqual(await translate(['b', 'c']), ['B', 'C']);
  assert.deepEqual(calls, [['a', 'b'], ['c']]);
  assert.deepEqual(await translate(['a', 'c']), ['A', 'C']);
  assert.equal(calls.length, 2);
});

test('splits a batch when the response is unusable', async () => {
  const { translate, calls } = setup(async (_p, texts) => {
    if (texts.length > 1) throw new TranslationError('bad_response', 'count');
    return texts.map((t) => t.toUpperCase());
  });
  assert.deepEqual(await translate(['a', 'b', 'c']), ['A', 'B', 'C']);
  assert.deepEqual(calls, [['a', 'b', 'c'], ['a', 'b'], ['a'], ['b'], ['c']]);
});

test('a text that keeps failing becomes null and is not cached', async () => {
  const { translate, calls } = setup(async (_p, texts) => {
    if (texts.includes('bad')) throw new TranslationError('bad_response', 'x');
    return texts;
  });
  assert.deepEqual(await translate(['ok', 'bad']), ['ok', null]);
  const before = calls.length;
  assert.deepEqual(await translate(['bad']), [null]);
  assert.equal(calls.length, before + 1);
});

test('retries rate limits before giving up', async () => {
  let n = 0;
  const { translate } = setup(async (_p, texts) => {
    if (++n === 1) throw new TranslationError('rate_limit', 'slow down');
    return texts;
  });
  assert.deepEqual(await translate(['a']), ['a']);
  assert.equal(n, 2);
});

test('fatal errors propagate', async () => {
  const { translate } = setup(async () => { throw new TranslationError('auth', 'key'); });
  await assert.rejects(translate(['a']), { kind: 'auth' });
});

test('invalid settings raise a config error without calling the provider', async () => {
  const { translate, calls } = setup(upper, mergeSettings({}));
  await assert.rejects(translate(['a']), { kind: 'config' });
  assert.equal(calls.length, 0);
});

test('translateWithSplit returns [] for empty input without calling', async () => {
  let called = false;
  assert.deepEqual(await translateWithSplit([], async () => { called = true; return []; }), []);
  assert.equal(called, false);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`translate-service.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/translate-service.js`:
```js
import { cacheKey } from './cache.js';
import { callProvider } from './providers/index.js';
import { withRetry } from './retry.js';
import { TranslationError } from './errors.js';
import { validateSettings } from './settings.js';

/** 応答が使えない（bad_response）ときはバッチを半分に分けて再依頼する。最後まで失敗した要素は null。 */
export async function translateWithSplit(texts, translateOnce) {
  if (!texts.length) return [];
  try {
    return await translateOnce(texts);
  } catch (err) {
    if (err?.kind !== 'bad_response') throw err;
    if (texts.length === 1) return [null];
    const mid = Math.ceil(texts.length / 2);
    const left = await translateWithSplit(texts.slice(0, mid), translateOnce);
    const right = await translateWithSplit(texts.slice(mid), translateOnce);
    return [...left, ...right];
  }
}

export function createTranslateService({ getSettings, cache, limiter, call = callProvider, fetch, sleep }) {
  return async function translateTexts(texts) {
    const settings = await getSettings();
    const invalid = validateSettings(settings);
    if (invalid) throw new TranslationError('config', invalid);
    limiter.setMax(settings.concurrency);

    const { provider, targetLang } = settings;
    const config = settings.providers[provider];
    const keys = await Promise.all(texts.map((t) => cacheKey(provider, config.model, targetLang, t)));
    const cached = await cache.getMany(keys);
    const result = cached.map((v) => v ?? null);
    const missing = [];
    cached.forEach((v, i) => {
      if (v === undefined) missing.push(i);
    });
    if (!missing.length) return result;

    const once = (subset) =>
      limiter.run(() => withRetry(() => call(provider, subset, targetLang, config, { fetch }), { sleep }));
    const translated = await translateWithSplit(missing.map((i) => texts[i]), once);

    const entries = [];
    missing.forEach((index, j) => {
      result[index] = translated[j];
      if (translated[j] != null) entries.push({ key: keys[index], value: translated[j] });
    });
    if (entries.length) await cache.setMany(entries);
    return result;
  };
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/translate-service.js test/translate-service.test.js
git commit -m "feat: add translate service with cache, split retry and limiter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: background service worker

**Files:**
- Create: `src/background.js`

**Interfaces:**
- Consumes: `loadSettings`, `validateSettings`（Task 2）; `createCache`（Task 6）; `createLimiter`（Task 3）; `createTranslateService`（Task 7）; `callProvider`（Task 5）; `toErrorPayload`, `TranslationError`（Task 1）
- Produces（`chrome.runtime.sendMessage` で受け付けるメッセージ。応答は常に `{ ok: true, ...data } | { ok: false, error: { kind, message } }`）:
  - `{ type: 'translateBatch', texts: string[] }` → `{ ok: true, translations: (string|null)[] }`
  - `{ type: 'getConfig' }` → `{ ok: true, maxUnitsPerBatch, maxCharsPerBatch, concurrency }`（設定不正なら `config` エラー）
  - `{ type: 'testConnection', settings: Settings }` → `{ ok: true, sample: string }`
  - `{ type: 'clearCache' }` → `{ ok: true }`
  - それ以外の type（例: content から popup への `progress`）には応答しない（`return false`）

`chrome.*` に依存するため単体テストはしない。動作確認は Task 15 の手動確認で行う。

- [ ] **Step 1: 実装する**

`src/background.js`:
```js
import { loadSettings, validateSettings } from './lib/settings.js';
import { createCache } from './lib/cache.js';
import { createLimiter } from './lib/limiter.js';
import { createTranslateService } from './lib/translate-service.js';
import { callProvider } from './lib/providers/index.js';
import { toErrorPayload, TranslationError } from './lib/errors.js';

const storage = chrome.storage.local;
const cache = createCache(storage);
const translateTexts = createTranslateService({
  getSettings: () => loadSettings(storage),
  cache,
  limiter: createLimiter(3),
});

function assertValid(settings) {
  const invalid = validateSettings(settings);
  if (invalid) throw new TranslationError('config', invalid);
}

const handlers = {
  async translateBatch({ texts }) {
    return { translations: await translateTexts(texts) };
  },
  async getConfig() {
    const s = await loadSettings(storage);
    assertValid(s);
    return { maxUnitsPerBatch: s.maxUnitsPerBatch, maxCharsPerBatch: s.maxCharsPerBatch, concurrency: s.concurrency };
  },
  async testConnection({ settings }) {
    assertValid(settings);
    const [sample] = await callProvider(settings.provider, ['Hello, world!'], settings.targetLang, settings.providers[settings.provider]);
    return { sample };
  },
  async clearCache() {
    await cache.clear();
    return {};
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(
    (data) => sendResponse({ ok: true, ...data }),
    (err) => sendResponse({ ok: false, error: toErrorPayload(err) }),
  );
  return true;
});
```

- [ ] **Step 2: 構文と依存を確認**

Run: `node --check src/background.js && node -e "import('./src/lib/translate-service.js').then(() => console.log('imports ok'))"`
Expected: `imports ok`

- [ ] **Step 3: 既存テストが通ることを確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add src/background.js
git commit -m "feat: add background service worker message handlers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: DOM からの翻訳単位の抽出と目印付き文字列

**Files:**
- Create: `src/lib/extract.js`
- Test: `test/extract.test.js`

**Interfaces:**
- Consumes: `makeDocument`（Task 1）
- Produces:
  - `STATUS_HOST_ID = 'apt-status-host'`
  - `collapse(s: string): string`（空白を1つにまとめて trim）
  - `isExcluded(el: Element): boolean`
  - `collectUnits(root: Element, { isSettled?: (textNodes: Text[]) => boolean }): RunUnit[]`
    - `RunUnit = { kind: 'run', parent: Element, nodes: Node[], text: string, textNodes: Text[] }`（`textNodes` は文字を含み、コード系要素の外にあるテキストノード）
  - `serializeRun(nodes: Node[]): { text: string, tokens: Token[] }`、`Token = { type: 'g'|'c'|'x', node: Node }`（配列の添字が目印番号）
  - `parseMarked(str: string): TreeNode[]`（不正なら `Error` を投げる）、`TreeNode = { type:'text', value } | { type:'g'|'c', id, children: TreeNode[] } | { type:'x', id }`
  - `matchesTokens(tree: TreeNode[], tokens: Token[]): boolean`
  - `textUnitsOf(unit: RunUnit): TextUnit[]`、`TextUnit = { kind: 'text', node: Text, text: string }`
  - `collectTitleUnit(doc: Document, isSettled: (title: string) => boolean): TitleUnit|null`、`TitleUnit = { kind: 'title', text: string }`

- [ ] **Step 1: 失敗するテストを書く**

`test/extract.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUnits, serializeRun, parseMarked, matchesTokens, textUnitsOf, collectTitleUnit, collapse, STATUS_HOST_ID,
} from '../src/lib/extract.js';
import { makeDocument } from './helpers/dom.js';

const texts = (html) => collectUnits(makeDocument(html).document.body).map((u) => u.text);

test('paragraph-level units', () => {
  assert.deepEqual(texts('<h1>Title</h1><p>First para.</p><ul><li>One</li><li>Two</li></ul>'), ['Title', 'First para.', 'One', 'Two']);
});

test('inline elements become g tags, code becomes c, void becomes x', () => {
  assert.deepEqual(texts('<p>Click <a href="/x">here</a> to <b>continue</b>.</p>'), ['Click <g0>here</g0> to <g1>continue</g1>.']);
  assert.deepEqual(texts('<p>Run <code>npm test</code> now</p>'), ['Run <c0>npm test</c0> now']);
  assert.deepEqual(texts('<p>a<br>b <img src="x.png"> c</p>'), ['a<x0/>b <x1/> c']);
  assert.deepEqual(texts('<p>A <a href="#"><em>deep</em> link</a></p>'), ['A <g0><g1>deep</g1> link</g0>']);
});

test('whitespace is collapsed and trimmed', () => {
  assert.deepEqual(texts('<p>\n   Hello\n   <b>world</b>   </p>'), ['Hello <g0>world</g0>']);
});

test('skips excluded content', () => {
  const html = `
    <script>var a = "Hello";</script><style>p{}</style><pre>Code block</pre>
    <textarea>Typed</textarea><div translate="no">Keep</div><div class="notranslate">Keep</div>
    <div contenteditable="true">Editing</div><div id="${STATUS_HOST_ID}">Status</div>
    <p>Visible</p>`;
  assert.deepEqual(texts(html), ['Visible']);
});

test('non-translatable inline elements inside a paragraph become x tags', () => {
  assert.deepEqual(texts('<p>Hi <span class="notranslate">Bob</span>!</p>'), ['Hi <x0/>!']);
});

test('standalone code and letterless text are skipped', () => {
  assert.deepEqual(texts('<div><code>x = 1</code></div><p>123 - 456</p><p>  </p>'), []);
});

test('text runs split around block children', () => {
  assert.deepEqual(texts('<div>Intro text<p>Para</p>Tail text</div>'), ['Intro text', 'Para', 'Tail text']);
});

test('inline elements containing blocks are walked as blocks', () => {
  assert.deepEqual(texts('<a href="#"><div>Card title</div><span>desc</span></a>'), ['Card title', '<g0>desc</g0>']);
});

test('iframes and media split runs instead of becoming tokens', () => {
  assert.deepEqual(texts('<div>Before<iframe src="about:blank"></iframe>After</div>'), ['Before', 'After']);
});

test('escapes literal tag-like text', () => {
  assert.deepEqual(texts('<p>a &lt;g0&gt; &amp; b</p>'), ['a &lt;g0&gt; &amp; b']);
});

test('isSettled filters units and receives translatable text nodes only', () => {
  const { document } = makeDocument('<p>One <code>x</code></p><p>Two</p>');
  const seen = [];
  const units = collectUnits(document.body, {
    isSettled: (nodes) => {
      seen.push(nodes.map((n) => n.data));
      return nodes[0].data === 'Two';
    },
  });
  assert.deepEqual(units.map((u) => u.text), ['One <c0>x</c0>']);
  assert.deepEqual(seen, [['One '], ['Two']]);
});

test('units expose parent, nodes and textNodes', () => {
  const { document } = makeDocument('<p id="p">Hi <b>there</b></p>');
  const [u] = collectUnits(document.body);
  assert.equal(u.kind, 'run');
  assert.equal(u.parent, document.getElementById('p'));
  assert.equal(u.nodes.length, 2);
  assert.deepEqual(u.textNodes.map((n) => n.data), ['Hi ', 'there']);
});

test('serializeRun returns tokens indexed by id', () => {
  const { document } = makeDocument('<p>A <a>b</a><br><code>c</code></p>');
  const { text, tokens } = serializeRun([...document.querySelector('p').childNodes]);
  assert.equal(text, 'A <g0>b</g0><x1/><c2>c</c2>');
  assert.deepEqual(tokens.map((t) => [t.type, t.node.nodeName]), [['g', 'A'], ['x', 'BR'], ['c', 'CODE']]);
});

test('parseMarked builds a tree and unescapes text', () => {
  assert.deepEqual(parseMarked('x <g1>y <x0 /></g1> &lt;z&gt;'), [
    { type: 'text', value: 'x ' },
    { type: 'g', id: 1, children: [{ type: 'text', value: 'y ' }, { type: 'x', id: 0 }] },
    { type: 'text', value: ' <z>' },
  ]);
  assert.deepEqual(parseMarked('<g0/>'), [{ type: 'g', id: 0, children: [] }]);
});

test('parseMarked rejects broken structure', () => {
  assert.throws(() => parseMarked('<g0>a'));
  assert.throws(() => parseMarked('a</g0>'));
  assert.throws(() => parseMarked('<g0><g1>a</g0></g1>'));
});

test('matchesTokens requires every token exactly once with the right type', () => {
  const tokens = [{ type: 'g' }, { type: 'x' }];
  assert.equal(matchesTokens(parseMarked('<x1/><g0>a</g0>'), tokens), true);
  assert.equal(matchesTokens(parseMarked('<g0>a</g0>'), tokens), false);
  assert.equal(matchesTokens(parseMarked('<g0>a</g0><x1/><x1/>'), tokens), false);
  assert.equal(matchesTokens(parseMarked('<c0>a</c0><x1/>'), tokens), false);
  assert.equal(matchesTokens(parseMarked('<g0>a</g0><x1/><x2/>'), tokens), false);
});

test('textUnitsOf splits a run into its text nodes', () => {
  const { document } = makeDocument('<p>Click <a>here</a> now <code>x</code></p>');
  const [u] = collectUnits(document.body);
  assert.deepEqual(textUnitsOf(u).map((t) => [t.kind, t.text]), [['text', 'Click'], ['text', 'here'], ['text', 'now']]);
});

test('collectTitleUnit', () => {
  const { document } = makeDocument('', { title: '  My   page ' });
  assert.deepEqual(collectTitleUnit(document, () => false), { kind: 'title', text: 'My page' });
  assert.equal(collectTitleUnit(document, () => true), null);
  assert.equal(collectTitleUnit(makeDocument('', { title: '123' }).document, () => false), null);
});

test('collapse', () => {
  assert.equal(collapse('  a \n\t b  '), 'a b');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`extract.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/extract.js`:
```js
export const STATUS_HOST_ID = 'apt-status-host';

const TEXT = 3;
const ELEMENT = 1;
const COMMENT = 8;

/** 段落の中で目印タグ化してよいインライン要素 */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
]);
/** 中身を訳さないインライン要素（<cN> タグ） */
const CODE_LIKE = new Set(['code', 'kbd', 'samp']);
/** 子を持たないインライン要素（<xN/> タグ） */
const VOID_INLINE = new Set(['br', 'img', 'wbr']);
/** 中身を翻訳しない要素 */
const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'pre', 'textarea', 'input', 'select', 'option',
  'svg', 'math', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'head',
]);
/** DOM 上で移動させると状態が壊れる要素。段落を区切る境界として扱う */
const BOUNDARY = new Set(['iframe', 'object', 'embed', 'video', 'audio', 'canvas']);

const LETTER = /\p{L}/u;

export const collapse = (s) => s.replace(/\s+/g, ' ').trim();

export function isExcluded(el) {
  if (SKIP.has(el.localName)) return true;
  if (el.id === STATUS_HOST_ID) return true;
  if (el.getAttribute('translate') === 'no') return true;
  if (el.classList?.contains('notranslate')) return true;
  const editable = el.getAttribute('contenteditable');
  return editable !== null && editable !== 'false';
}

/** 段落内で中身ごと1つの <xN/> として扱うノード */
function isOpaque(node) {
  if (node.nodeType !== ELEMENT) return node.nodeType !== TEXT;
  return VOID_INLINE.has(node.localName) || isExcluded(node);
}

function isPureInline(el) {
  if (!INLINE.has(el.localName) || isExcluded(el)) return false;
  for (const child of el.children) {
    if (BOUNDARY.has(child.localName)) return false;
    if (isOpaque(child)) continue;
    if (!isPureInline(child)) return false;
  }
  return true;
}

function collectTextNodes(nodes, { skipCode }) {
  const out = [];
  const visit = (n) => {
    if (n.nodeType === TEXT) {
      out.push(n);
      return;
    }
    if (n.nodeType !== ELEMENT || isOpaque(n)) return;
    if (skipCode && CODE_LIKE.has(n.localName)) return;
    n.childNodes.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function serializeRun(nodes) {
  const tokens = [];
  const serialize = (n) => {
    if (n.nodeType === TEXT) return escapeText(n.data);
    const id = tokens.length;
    if (isOpaque(n)) {
      tokens.push({ type: 'x', node: n });
      return `<x${id}/>`;
    }
    const type = CODE_LIKE.has(n.localName) ? 'c' : 'g';
    tokens.push({ type, node: n });
    const inner = [...n.childNodes].map(serialize).join('');
    return `<${type}${id}>${inner}</${type}${id}>`;
  };
  return { text: collapse(nodes.map(serialize).join('')), tokens };
}

export function collectUnits(root, { isSettled = () => false } = {}) {
  const units = [];

  const flush = (parent, run) => {
    if (!run.length) return;
    const textNodes = collectTextNodes(run, { skipCode: true }).filter((n) => LETTER.test(n.data));
    if (!textNodes.length || isSettled(textNodes)) return;
    units.push({ kind: 'run', parent, nodes: run, text: serializeRun(run).text, textNodes });
  };

  const walk = (el) => {
    let run = [];
    for (const child of [...el.childNodes]) {
      if (child.nodeType === TEXT || child.nodeType === COMMENT) {
        run.push(child);
      } else if (child.nodeType !== ELEMENT) {
        continue;
      } else if (BOUNDARY.has(child.localName)) {
        flush(el, run);
        run = [];
      } else if (isOpaque(child) || isPureInline(child)) {
        run.push(child);
      } else {
        flush(el, run);
        run = [];
        if (!isExcluded(child)) walk(child);
      }
    }
    flush(el, run);
  };

  if (!isExcluded(root)) walk(root);
  return units;
}

const TAG = /<(\/)?([gcx])(\d+)\s*(\/)?>/g;

export function parseMarked(str) {
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  const pushText = (s) => {
    if (s) stack.at(-1).children.push({ type: 'text', value: unescapeText(s) });
  };
  for (const m of str.matchAll(TAG)) {
    pushText(str.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, type, idText, selfClosing] = m;
    const id = Number(idText);
    if (closing) {
      const top = stack.at(-1);
      if (stack.length === 1 || top.type !== type || top.id !== id) throw new Error(`unexpected </${type}${id}>`);
      stack.pop();
    } else if (type === 'x') {
      stack.at(-1).children.push({ type: 'x', id });
    } else {
      const node = { type, id, children: [] };
      stack.at(-1).children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  pushText(str.slice(last));
  if (stack.length !== 1) throw new Error('unclosed tag');
  return root.children;
}

export function matchesTokens(tree, tokens) {
  const counts = new Array(tokens.length).fill(0);
  let ok = true;
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') continue;
      if (tokens[n.id]?.type !== n.type) {
        ok = false;
        return;
      }
      counts[n.id]++;
      if (n.children) visit(n.children);
    }
  };
  visit(tree);
  return ok && counts.every((c) => c === 1);
}

export function textUnitsOf(unit) {
  return unit.textNodes.map((node) => ({ kind: 'text', node, text: collapse(node.data) }));
}

export function collectTitleUnit(doc, isSettled) {
  const title = doc.title;
  if (!LETTER.test(title) || isSettled(title)) return null;
  return { kind: 'title', text: collapse(title) };
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/extract.js test/extract.test.js
git commit -m "feat: extract translation units with placeholder tags" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 訳文の反映と原文への復元

**Files:**
- Create: `src/lib/rebuild.js`
- Test: `test/rebuild.test.js`

**Interfaces:**
- Consumes: `serializeRun`, `parseMarked`, `matchesTokens`, `collapse`, `collectUnits`, `textUnitsOf`, `collectTitleUnit`（Task 9）; `makeDocument`（Task 1）
- Produces:
  - `createDomState(): DomState`（`{ seen: WeakMap<Text,string>, records: Record[], titleWritten: string|null }`）
  - `isOwnText(state, node: Text): boolean`（拡張機能が書いた内容のままか）
  - `applyRun(state, unit: RunUnit, translated: string): 'applied'|'stale'|'mismatch'`
  - `applyText(state, unit: TextUnit, translated: string): 'applied'|'stale'|'failed'`
  - `applyTitle(state, doc, unit: TitleUnit, translated: string): 'applied'|'stale'|'failed'`
  - `restoreAll(state, doc): void`（記録を逆順に戻し、state をリセット）

- [ ] **Step 1: 失敗するテストを書く**

`test/rebuild.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDomState, applyRun, applyText, applyTitle, restoreAll, isOwnText } from '../src/lib/rebuild.js';
import { collectUnits, textUnitsOf, collectTitleUnit } from '../src/lib/extract.js';
import { makeDocument } from './helpers/dom.js';

function setup(html, title = '') {
  const { document } = makeDocument(html, { title });
  return { document, state: createDomState(), units: collectUnits(document.body) };
}

test('applyRun reorders tags and reuses the original elements', () => {
  const { document, state, units } = setup('<p>Click <a href="/x" class="k">here</a> to <b>continue</b>.</p>');
  const link = document.querySelector('a');
  let clicked = 0;
  link.addEventListener('click', () => clicked++);
  assert.equal(applyRun(state, units[0], '<g1>続行</g1>するには<g0>ここ</g0>をクリック。'), 'applied');
  const p = document.querySelector('p');
  assert.equal(p.innerHTML, '<b>続行</b>するには<a href="/x" class="k">ここ</a>をクリック。');
  assert.equal(document.querySelector('a'), link);
  link.click();
  assert.equal(clicked, 1);
  for (const n of [...p.childNodes].filter((n) => n.nodeType === 3)) assert.equal(isOwnText(state, n), true);
});

test('restoreAll returns the exact original markup', () => {
  const html = '<h1>Title</h1><p>Click <a href="/x">here</a> to <b>go <i>now</i></b>.<br>Next</p><div>Intro<p>Para</p>Tail</div>';
  const { document, state, units } = setup(html, 'Page');
  for (const u of units) assert.equal(applyRun(state, u, `訳:${u.text}`), 'applied');
  const title = collectTitleUnit(document, () => false);
  assert.equal(applyTitle(state, document, title, 'ページ'), 'applied');
  assert.notEqual(document.body.innerHTML, html);
  restoreAll(state, document);
  assert.equal(document.body.innerHTML, html);
  assert.equal(document.title, 'Page');
  assert.deepEqual(state.records, []);
});

test('mismatched tags leave the DOM untouched', () => {
  const { document, state, units } = setup('<p>Click <a>here</a></p>');
  const before = document.body.innerHTML;
  assert.equal(applyRun(state, units[0], 'ここをクリック'), 'mismatch');
  assert.equal(applyRun(state, units[0], '<g0>ここ'), 'mismatch');
  assert.equal(applyRun(state, units[0], '   '), 'mismatch');
  assert.equal(document.body.innerHTML, before);
});

test('stale when the page changed the run meanwhile', () => {
  const { document, state, units } = setup('<p>Hello</p>');
  units[0].nodes[0].data = 'Changed';
  assert.equal(applyRun(state, units[0], 'こんにちは'), 'stale');
  assert.equal(document.querySelector('p').textContent, 'Changed');
  const fresh = collectUnits(document.body)[0];
  fresh.nodes[0].remove();
  assert.equal(applyRun(state, fresh, 'x'), 'stale');
});

test('applyText keeps surrounding whitespace and restores', () => {
  const { document, state, units } = setup('<p>Click <a>here</a> now.</p>');
  const parts = textUnitsOf(units[0]);
  assert.equal(applyText(state, parts[0], 'クリック'), 'applied');
  assert.equal(applyText(state, parts[1], 'ここ'), 'applied');
  assert.equal(applyText(state, parts[2], '今。'), 'applied');
  assert.equal(document.querySelector('p').innerHTML, 'クリック <a>ここ</a> 今。');
  assert.equal(applyText(state, parts[0], 'again'), 'stale');
  assert.equal(applyText(state, { kind: 'text', node: document.createTextNode('x'), text: 'x' }, ''), 'failed');
  restoreAll(state, document);
  assert.equal(document.querySelector('p').innerHTML, 'Click <a>here</a> now.');
});

test('re-translating translated content restores in the right order', () => {
  const { document, state, units } = setup('<p>Hello <b>world</b></p>');
  applyRun(state, units[0], 'こんにちは <g0>世界</g0>');
  document.querySelector('p').append(' extra');
  const again = collectUnits(document.body)[0];
  assert.equal(applyRun(state, again, 'こんにちは <g0>世界</g0> 追加'), 'applied');
  restoreAll(state, document);
  assert.equal(document.querySelector('p').innerHTML, 'Hello <b>world</b> extra');
});

test('restoreAll tolerates content the page removed', () => {
  const { document, state, units } = setup('<p id="a">One</p><p id="b">Two</p>');
  applyRun(state, units[0], '一');
  applyRun(state, units[1], '二');
  document.getElementById('a').remove();
  assert.doesNotThrow(() => restoreAll(state, document));
  assert.equal(document.body.innerHTML, '<p id="b">Two</p>');
});

test('keeps literal tag-like text as text', () => {
  const { document, state, units } = setup('<p>a &lt;g0&gt; b</p>');
  assert.equal(applyRun(state, units[0], 'あ &lt;g0&gt; い'), 'applied');
  assert.equal(document.querySelector('p').textContent, 'あ <g0> い');
});

test('applyTitle is stale when the page retitled itself and failed on empty output', () => {
  const { document, state } = setup('', 'Page');
  const unit = collectTitleUnit(document, () => false);
  assert.equal(applyTitle(state, document, unit, ' '), 'failed');
  document.title = 'Other';
  assert.equal(applyTitle(state, document, unit, 'ページ'), 'stale');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`rebuild.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/rebuild.js`:
```js
import { serializeRun, parseMarked, matchesTokens, collapse } from './extract.js';

export function createDomState() {
  return { seen: new WeakMap(), records: [], titleWritten: null };
}

/** 拡張機能が書いた内容のまま残っているテキストノードか */
export function isOwnText(state, node) {
  return state.seen.get(node) === node.data;
}

function isRunIntact(unit) {
  return unit.nodes.every((n, i) => n.parentNode === unit.parent && (i === 0 || unit.nodes[i - 1].nextSibling === n));
}

export function applyRun(state, unit, translated) {
  if (!isRunIntact(unit)) return 'stale';
  const { text, tokens } = serializeRun(unit.nodes);
  if (text !== unit.text) return 'stale';

  let tree;
  try {
    tree = parseMarked(translated.trim());
  } catch {
    return 'mismatch';
  }
  if (!tree.length || !matchesTokens(tree, tokens)) return 'mismatch';

  const doc = unit.parent.ownerDocument;
  const elementChildren = tokens
    .filter((t) => t.type !== 'x')
    .map((t) => ({ node: t.node, children: [...t.node.childNodes] }));
  const marker = doc.createComment('apt');
  unit.parent.insertBefore(marker, unit.nodes[0]);

  const created = [];
  const build = (nodes) =>
    nodes.map((n) => {
      if (n.type === 'text') {
        const t = doc.createTextNode(n.value);
        created.push(t);
        return t;
      }
      const { node } = tokens[n.id];
      if (n.type !== 'x') node.replaceChildren(...build(n.children));
      return node;
    });
  const top = build(tree);

  for (const n of unit.nodes) if (n.parentNode === unit.parent) n.remove();
  for (const n of top) unit.parent.insertBefore(n, marker);
  marker.remove();

  for (const t of created) state.seen.set(t, t.data);
  state.records.push({ kind: 'run', parent: unit.parent, originals: unit.nodes.slice(), elementChildren, current: top });
  return 'applied';
}

export function applyText(state, unit, translated) {
  const { node } = unit;
  const value = translated.trim();
  if (!value) return 'failed';
  if (!node.parentNode || collapse(node.data) !== unit.text) return 'stale';
  const original = node.data;
  const lead = original.match(/^\s*/)[0];
  const trail = original.match(/\s*$/)[0];
  node.data = lead + value + trail;
  state.seen.set(node, node.data);
  state.records.push({ kind: 'text', node, original, written: node.data });
  return 'applied';
}

export function applyTitle(state, doc, unit, translated) {
  const value = translated.trim();
  if (!value) return 'failed';
  if (collapse(doc.title) !== unit.text) return 'stale';
  const original = doc.title;
  doc.title = value;
  state.titleWritten = doc.title;
  state.records.push({ kind: 'title', original, written: doc.title });
  return 'applied';
}

function restoreRun(doc, record) {
  const { parent, current, originals, elementChildren } = record;
  const first = current.find((n) => n.parentNode === parent);
  if (!first) return;
  const marker = doc.createComment('apt');
  parent.insertBefore(marker, first);
  for (const n of current) if (n.parentNode === parent) n.remove();
  for (const { node, children } of elementChildren) node.replaceChildren(...children);
  for (const n of originals) parent.insertBefore(n, marker);
  marker.remove();
}

export function restoreAll(state, doc) {
  for (const record of state.records.reverse()) {
    if (record.kind === 'run') restoreRun(doc, record);
    else if (record.kind === 'text' && record.node.data === record.written) record.node.data = record.original;
    else if (record.kind === 'title' && doc.title === record.written) doc.title = record.original;
  }
  state.records = [];
  state.seen = new WeakMap();
  state.titleWritten = null;
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/rebuild.js test/rebuild.test.js
git commit -m "feat: apply translations to the DOM and restore originals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: ページ翻訳の進行管理（page-translator）

**Files:**
- Create: `src/lib/page-translator.js`
- Test: `test/page-translator.test.js`

**Interfaces:**
- Consumes: `collectUnits`, `textUnitsOf`, `collectTitleUnit`（Task 9）; `createDomState`, `isOwnText`, `applyRun`, `applyText`, `applyTitle`, `restoreAll`（Task 10）; `makeBatches`（Task 3）; `FATAL_KINDS`（Task 1）
- Produces:
  - `createPageTranslator({ document, sendMessage, onStatus?, debounceMs = 500, MutationObserverImpl = globalThis.MutationObserver, isInViewport = () => true })`
    → `{ translate(): Promise<Status>, stop(): void, restore(): void, getStatus(): Status }`
  - `Status = { state: 'idle'|'translating'|'done'|'stopped'|'error', done: number, total: number, failed: number, error: {kind,message}|null }`
  - `sendMessage(msg)` は background と同じ形の応答（Task 8）を返す Promise。`getConfig` → `{ ok, maxUnitsPerBatch, maxCharsPerBatch, concurrency }`、`translateBatch` → `{ ok, translations }`。
  - 状態 `done` の間は MutationObserver で監視を続け、追加分を翻訳する。

- [ ] **Step 1: 失敗するテストを書く**

`test/page-translator.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageTranslator } from '../src/lib/page-translator.js';
import { makeDocument } from './helpers/dom.js';

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(html) {
  const { window, document } = makeDocument(html, { title: 'Hello page' });
  const ctl = { failWith: null, translate: (t) => `[ja]${t}` };
  const batches = [];
  const sendMessage = async (msg) => {
    if (msg.type === 'getConfig') return { ok: true, maxUnitsPerBatch: 40, maxCharsPerBatch: 3000, concurrency: 2 };
    if (msg.type === 'translateBatch') {
      batches.push(msg.texts);
      if (ctl.failWith) return { ok: false, error: ctl.failWith };
      return { ok: true, translations: msg.texts.map((t) => ctl.translate(t)) };
    }
    throw new Error(`unexpected ${msg.type}`);
  };
  const statuses = [];
  const pt = createPageTranslator({
    document, sendMessage, onStatus: (s) => statuses.push(s), debounceMs: 10, MutationObserverImpl: window.MutationObserver,
  });
  return { document, pt, ctl, batches, statuses };
}

test('translates body and title, keeping elements', async () => {
  const { document, pt, statuses } = setup('<p>Click <a href="/x">here</a> now.</p><p>Second</p>');
  const link = document.querySelector('a');
  const status = await pt.translate();
  assert.equal(document.querySelector('p').innerHTML, '[ja]Click <a href="/x">here</a> now.');
  assert.equal(document.querySelectorAll('p')[1].textContent, '[ja]Second');
  assert.equal(document.title, '[ja]Hello page');
  assert.equal(document.querySelector('a'), link);
  assert.deepEqual(status, { state: 'done', done: 3, total: 3, failed: 0, error: null });
  assert.equal(statuses[0].state, 'translating');
  pt.stop();
});

test('restore brings back the original page', async () => {
  const html = '<p>Click <a href="/x">here</a> now.</p><p>Second</p>';
  const { document, pt } = setup(html);
  await pt.translate();
  pt.restore();
  assert.equal(document.body.innerHTML, html);
  assert.equal(document.title, 'Hello page');
  assert.equal(pt.getStatus().state, 'idle');
});

test('translates content added later', async () => {
  const { document, pt } = setup('<p>First</p>');
  await pt.translate();
  const p = document.createElement('p');
  p.textContent = 'Later';
  document.body.append(p);
  await waitFor(() => p.textContent === '[ja]Later');
  assert.equal(pt.getStatus().state, 'done');
  pt.stop();
});

test('re-translates text the page rewrites after translation', async () => {
  const { document, pt } = setup('<p>First</p><p>Second</p>');
  await pt.translate();
  const second = document.querySelectorAll('p')[1];
  second.firstChild.data = 'Rewritten';
  await waitFor(() => second.textContent === '[ja]Rewritten');
  pt.stop();
});

test('a fatal error stops everything and leaves the page unchanged', async () => {
  const { document, pt, ctl } = setup('<p>One</p>');
  ctl.failWith = { kind: 'auth', message: 'APIキーを確認してください' };
  const status = await pt.translate();
  assert.equal(status.state, 'error');
  assert.equal(status.error.kind, 'auth');
  assert.equal(document.querySelector('p').textContent, 'One');
});

test('retries everything after a fatal error once translate is pressed again', async () => {
  const { document, pt, ctl } = setup('<p>One</p>');
  ctl.failWith = { kind: 'auth', message: 'x' };
  await pt.translate();
  ctl.failWith = null;
  const status = await pt.translate();
  assert.equal(status.state, 'done');
  assert.equal(document.querySelector('p').textContent, '[ja]One');
  pt.stop();
});

test('a config error from getConfig is reported', async () => {
  const { document } = makeDocument('<p>One</p>');
  const pt = createPageTranslator({
    document,
    sendMessage: async () => ({ ok: false, error: { kind: 'config', message: 'APIキーを設定してください' } }),
  });
  const status = await pt.translate();
  assert.equal(status.state, 'error');
  assert.equal(status.error.message, 'APIキーを設定してください');
});

test('non-fatal batch failures are counted and translation finishes', async () => {
  const { pt, ctl } = setup('<p>One</p><p>Two</p>');
  ctl.failWith = { kind: 'rate_limit', message: 'slow' };
  const status = await pt.translate();
  assert.equal(status.state, 'done');
  assert.equal(status.failed, 3);
  assert.equal(status.done, 3);
  pt.stop();
});

test('null translations count as failures', async () => {
  const { document, pt, ctl } = setup('<p>One</p><p>Two</p>');
  ctl.translate = (t) => (t === 'Two' ? null : `[ja]${t}`);
  const status = await pt.translate();
  assert.equal(status.failed, 1);
  assert.equal(document.querySelectorAll('p')[1].textContent, 'Two');
  pt.stop();
});

test('falls back to per-text-node translation when tags do not match', async () => {
  const { document, pt, ctl, batches } = setup('<p>Click <a href="/x">here</a> now.</p>');
  ctl.translate = (t) => `[ja]${t.replace(/<\/?[gcx]\d+\/?>/g, '')}`;
  const link = document.querySelector('a');
  const status = await pt.translate();
  assert.equal(document.querySelector('p').innerHTML, '[ja]Click <a href="/x">[ja]here</a> [ja]now.');
  assert.equal(document.querySelector('a'), link);
  assert.deepEqual(batches.at(-1), ['Click', 'here', 'now.']);
  assert.equal(status.total, 5);
  assert.equal(status.done, 5);
  pt.stop();
});

test('stop ends observation of new content', async () => {
  const { document, pt } = setup('<p>One</p>');
  await pt.translate();
  pt.stop();
  assert.equal(pt.getStatus().state, 'stopped');
  const p = document.createElement('p');
  p.textContent = 'Later';
  document.body.append(p);
  await sleep(50);
  assert.equal(p.textContent, 'Later');
});

test('translate while already running is a no-op', async () => {
  const { pt, batches } = setup('<p>One</p>');
  await Promise.all([pt.translate(), pt.translate()]);
  assert.equal(batches.length, 1);
  pt.stop();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`page-translator.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/lib/page-translator.js`:
```js
import { collectUnits, textUnitsOf, collectTitleUnit } from './extract.js';
import { createDomState, isOwnText, applyRun, applyText, applyTitle, restoreAll } from './rebuild.js';
import { makeBatches } from './batch.js';
import { FATAL_KINDS } from './errors.js';

const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
const NO_BACKGROUND = { kind: 'unknown', message: 'バックグラウンドに接続できません' };

export function createPageTranslator({
  document,
  sendMessage,
  onStatus = () => {},
  debounceMs = 500,
  MutationObserverImpl = globalThis.MutationObserver,
  isInViewport = () => true,
}) {
  const dom = createDomState();
  let status = { state: 'idle', done: 0, total: 0, failed: 0, error: null };
  let session = 0;
  let config = null;
  let observer = null;
  let timer = null;
  let queue = Promise.resolve();
  // 送信済み（翻訳待ち・失敗含む）の原文。「翻訳」を押し直すたびにリセットして失敗分を再試行する
  let claimed = new WeakMap();
  let claimedTitle = null;

  const emit = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };

  const isSettledNodes = (nodes) => nodes.every((n) => isOwnText(dom, n) || claimed.get(n) === n.data);
  const isSettledTitle = (title) => title === dom.titleWritten || title === claimedTitle;

  function claim(unit) {
    if (unit.kind === 'run') for (const n of unit.textNodes) claimed.set(n, n.data);
    else if (unit.kind === 'text') claimed.set(unit.node, unit.node.data);
    else claimedTitle = document.title;
  }

  function apply(unit, translated) {
    if (unit.kind === 'run') return applyRun(dom, unit, translated);
    if (unit.kind === 'text') return applyText(dom, unit, translated);
    return applyTitle(dom, document, unit, translated);
  }

  function scheduleScan(id) {
    clearTimeout(timer);
    timer = setTimeout(() => scan(id), debounceMs);
  }

  function startObserver(id) {
    stopObserver();
    observer = new MutationObserverImpl(() => scheduleScan(id));
    observer.observe(document.documentElement, OBSERVE_OPTIONS);
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
  }

  /** 自分の DOM 書き換えを監視対象にしない */
  function withObserverPaused(fn) {
    if (!observer) return fn();
    const pending = observer.takeRecords();
    observer.disconnect();
    try {
      return fn();
    } finally {
      observer.observe(document.documentElement, OBSERVE_OPTIONS);
      if (pending.length) scheduleScan(session);
    }
  }

  function fail(error) {
    session++;
    stopObserver();
    emit({ state: 'error', error });
  }

  async function translateUnits(id, units) {
    const batches = makeBatches(units.map((u) => u.text), {
      maxUnits: config.maxUnitsPerBatch,
      maxChars: config.maxCharsPerBatch,
    }).map((indices) => indices.map((i) => units[i]));
    const fallback = [];

    const worker = async () => {
      while (batches.length && id === session) {
        const batch = batches.shift();
        const res = await sendMessage({ type: 'translateBatch', texts: batch.map((u) => u.text) });
        if (id !== session) return;
        if (!res?.ok) {
          const error = res?.error ?? NO_BACKGROUND;
          if (FATAL_KINDS.has(error.kind)) return fail(error);
          emit({ done: status.done + batch.length, failed: status.failed + batch.length, error });
          continue;
        }
        let failed = 0;
        withObserverPaused(() => {
          batch.forEach((unit, i) => {
            const translated = res.translations[i];
            if (translated == null) return void failed++;
            const result = apply(unit, translated);
            if (result === 'failed') failed++;
            else if (result === 'mismatch') fallback.push(...textUnitsOf(unit));
          });
        });
        emit({ done: status.done + batch.length, failed: status.failed + failed });
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
    if (fallback.length && id === session) {
      emit({ total: status.total + fallback.length });
      await translateUnits(id, fallback);
    }
  }

  async function runScan(id) {
    try {
      const units = collectUnits(document.body, { isSettled: isSettledNodes });
      const title = collectTitleUnit(document, isSettledTitle);
      if (title) units.unshift(title);
      if (units.length) {
        units.forEach(claim);
        units.sort((a, b) => Number(isInViewport(b)) - Number(isInViewport(a)));
        emit({ state: 'translating', total: status.total + units.length });
        await translateUnits(id, units);
      }
      if (id === session && status.state === 'translating') emit({ state: 'done' });
    } catch (err) {
      if (id === session) fail({ kind: 'unknown', message: String(err?.message ?? err) });
    }
  }

  function scan(id) {
    queue = queue.then(() => (id === session ? runScan(id) : undefined));
    return queue;
  }

  async function translate() {
    if (status.state === 'translating' || status.state === 'done') return status;
    const id = ++session;
    claimed = new WeakMap();
    claimedTitle = null;
    emit({ state: 'translating', done: 0, total: 0, failed: 0, error: null });
    const res = await sendMessage({ type: 'getConfig' });
    if (id !== session) return status;
    if (!res?.ok) {
      fail(res?.error ?? NO_BACKGROUND);
      return status;
    }
    config = res;
    startObserver(id);
    await scan(id);
    return status;
  }

  function stop() {
    session++;
    stopObserver();
    if (status.state !== 'idle') emit({ state: 'stopped' });
  }

  function restore() {
    session++;
    stopObserver();
    restoreAll(dom, document);
    emit({ state: 'idle', done: 0, total: 0, failed: 0, error: null });
  }

  return { translate, stop, restore, getStatus: () => status };
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/page-translator.js test/page-translator.test.js
git commit -m "feat: orchestrate page translation with live updates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: ページ上の状態表示と content script

**Files:**
- Create: `src/lib/status-overlay.js`, `src/content.js`
- Test: `test/status-overlay.test.js`

**Interfaces:**
- Consumes: `STATUS_HOST_ID`（Task 9）; `createPageTranslator`, `Status`（Task 11）
- Produces:
  - `statusText(status: Status): string`（idle は空文字）
  - `createStatusOverlay(doc, { dimAfterMs = 4000 }): { update(status): void, hide(): void, readonly element: HTMLElement|null }`
  - content script が受け付けるメッセージ（`chrome.tabs.sendMessage`）: `{ type: 'translate'|'stop'|'restore'|'status' }` → `{ ok: true, status: Status }`
  - content script が送る進捗: `chrome.runtime.sendMessage({ type: 'progress', status })`

- [ ] **Step 1: 失敗するテストを書く**

`test/status-overlay.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusText, createStatusOverlay } from '../src/lib/status-overlay.js';
import { STATUS_HOST_ID } from '../src/lib/extract.js';
import { makeDocument } from './helpers/dom.js';

const base = { done: 0, total: 0, failed: 0, error: null };

test('statusText for each state', () => {
  assert.equal(statusText({ ...base, state: 'idle' }), '');
  assert.equal(statusText({ ...base, state: 'translating', done: 12, total: 40 }), '翻訳中… 12/40');
  assert.equal(statusText({ ...base, state: 'done' }), '翻訳完了');
  assert.equal(statusText({ ...base, state: 'done', failed: 2 }), '翻訳完了（2件失敗）');
  assert.equal(
    statusText({ ...base, state: 'done', failed: 2, error: { kind: 'rate_limit', message: 'レート制限' } }),
    '翻訳完了（2件失敗: レート制限）',
  );
  assert.equal(statusText({ ...base, state: 'stopped', done: 3, total: 9 }), '停止しました（3/9）');
  assert.equal(statusText({ ...base, state: 'error', error: { kind: 'auth', message: 'APIキーを確認してください' } }), 'エラー: APIキーを確認してください');
});

test('overlay appears while active and disappears when idle', () => {
  const { document } = makeDocument('<p>x</p>');
  const overlay = createStatusOverlay(document);
  overlay.update({ ...base, state: 'translating', total: 1 });
  const host = document.getElementById(STATUS_HOST_ID);
  assert.ok(host);
  assert.equal(host.parentNode, document.documentElement);
  overlay.update({ ...base, state: 'done', done: 1, total: 1 });
  assert.equal(document.querySelectorAll(`#${STATUS_HOST_ID}`).length, 1);
  overlay.update({ ...base, state: 'idle' });
  assert.equal(document.getElementById(STATUS_HOST_ID), null);
  overlay.hide();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`status-overlay.js` が存在しない）

- [ ] **Step 3: 状態表示を実装する**

`src/lib/status-overlay.js`:
```js
import { STATUS_HOST_ID } from './extract.js';

export function statusText(status) {
  switch (status.state) {
    case 'translating':
      return `翻訳中… ${status.done}/${status.total}`;
    case 'done':
      if (!status.failed) return '翻訳完了';
      return status.error ? `翻訳完了（${status.failed}件失敗: ${status.error.message}）` : `翻訳完了（${status.failed}件失敗）`;
    case 'stopped':
      return `停止しました（${status.done}/${status.total}）`;
    case 'error':
      return `エラー: ${status.error?.message ?? '不明なエラー'}`;
    default:
      return '';
  }
}

const CSS = `
  :host { all: initial; }
  .box {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; gap: 8px; align-items: center; max-width: 360px; padding: 8px 12px;
    border-radius: 8px; background: #1f2937; color: #f9fafb;
    font: 13px/1.4 system-ui, -apple-system, "Hiragino Sans", sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, .25); transition: opacity .3s, transform .3s;
  }
  .box.error { background: #b91c1c; }
  .box.dim { opacity: .45; transform: scale(.9); transform-origin: bottom right; }
  .close { all: unset; cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1; }
`;

export function createStatusOverlay(doc, { dimAfterMs = 4000 } = {}) {
  let host = null;
  let box = null;
  let message = null;
  let timer = null;

  function ensure() {
    if (host?.isConnected) return;
    host = doc.createElement('div');
    host.id = STATUS_HOST_ID;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="box" role="status" aria-live="polite"><span class="msg"></span><button type="button" class="close" aria-label="閉じる">×</button></div>`;
    box = root.querySelector('.box');
    message = root.querySelector('.msg');
    root.querySelector('.close').addEventListener('click', hide);
    doc.documentElement.appendChild(host);
  }

  function hide() {
    clearTimeout(timer);
    host?.remove();
    host = null;
  }

  function update(status) {
    const text = statusText(status);
    if (!text) return hide();
    ensure();
    clearTimeout(timer);
    message.textContent = text;
    box.classList.toggle('error', status.state === 'error');
    box.classList.remove('dim');
    if (status.state === 'done' || status.state === 'stopped') {
      timer = setTimeout(() => box?.classList.add('dim'), dimAfterMs);
    }
  }

  return {
    update,
    hide,
    get element() {
      return host;
    },
  };
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: content script を実装する**

`src/content.js`（ES Modules として読み込まれないため、通常のスクリプトとして書き、`lib/` は動的 import する）:
```js
(() => {
  if (globalThis.__aptContentLoaded) return;
  globalThis.__aptContentLoaded = true;

  const isInViewport = (unit) => {
    const el = unit.kind === 'run' ? unit.parent : unit.kind === 'text' ? unit.node.parentElement : null;
    if (!el) return true;
    const rect = el.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= window.innerHeight;
  };

  const ready = (async () => {
    const [{ createPageTranslator }, { createStatusOverlay }] = await Promise.all([
      import(chrome.runtime.getURL('src/lib/page-translator.js')),
      import(chrome.runtime.getURL('src/lib/status-overlay.js')),
    ]);
    const overlay = createStatusOverlay(document);
    return createPageTranslator({
      document,
      isInViewport,
      sendMessage: (message) =>
        chrome.runtime.sendMessage(message).catch((err) => ({
          ok: false,
          error: { kind: 'unknown', message: String(err?.message ?? err) },
        })),
      onStatus: (status) => {
        overlay.update(status);
        chrome.runtime.sendMessage({ type: 'progress', status }).catch(() => {});
      },
    });
  })();

  const actions = {
    translate: (t) => {
      t.translate();
      return t.getStatus();
    },
    stop: (t) => {
      t.stop();
      return t.getStatus();
    },
    restore: (t) => {
      t.restore();
      return t.getStatus();
    },
    status: (t) => t.getStatus(),
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = actions[message?.type];
    if (!action) return false;
    ready.then(
      (translator) => sendResponse({ ok: true, status: action(translator) }),
      (err) => sendResponse({ ok: false, error: { kind: 'unknown', message: String(err?.message ?? err) } }),
    );
    return true;
  });
})();
```

- [ ] **Step 6: 構文を確認**

Run: `node --check src/content.js && npm test`
Expected: エラーなし、PASS

- [ ] **Step 7: コミット**

```bash
git add src/lib/status-overlay.js src/content.js test/status-overlay.test.js
git commit -m "feat: add on-page status overlay and content script" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: ポップアップ

**Files:**
- Create: `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`

**Interfaces:**
- Consumes: `loadSettings`, `PROVIDER_LABELS`（Task 2）; `statusText`（Task 12）; content script のメッセージ（Task 12）
- Produces: なし（UI）

`chrome.*` に依存するため単体テストはしない。動作確認は Task 15 の手動確認で行う。

- [ ] **Step 1: HTML と CSS を書く**

`src/popup/popup.html`:
```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>AI Page Translator</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <header>
    <h1>AI Page Translator</h1>
    <p id="provider" class="sub"></p>
  </header>
  <div class="actions">
    <button id="translate" class="primary" type="button">翻訳</button>
    <button id="stop" type="button">停止</button>
    <button id="restore" type="button">原文に戻す</button>
  </div>
  <p id="status" class="status" aria-live="polite">待機中</p>
  <a id="open-options" href="#">設定を開く</a>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

`src/popup/popup.css`:
```css
:root { color-scheme: light dark; --accent: #2563eb; }
body { width: 280px; margin: 0; padding: 12px 14px; font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif; }
h1 { margin: 0; font-size: 15px; }
.sub { margin: 2px 0 10px; color: GrayText; font-size: 12px; word-break: break-all; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.actions .primary { grid-column: 1 / -1; }
button { padding: 7px 10px; border: 1px solid #9ca3af; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
button.primary { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
.status { min-height: 1.5em; margin: 10px 0 6px; }
.status.error { color: #dc2626; }
a { color: var(--accent); font-size: 12px; }
```

- [ ] **Step 2: スクリプトを書く**

`src/popup/popup.js`:
```js
import { loadSettings, PROVIDER_LABELS } from '../lib/settings.js';
import { statusText } from '../lib/status-overlay.js';

const $ = (id) => document.getElementById(id);
let tabId;

async function sendToTab(message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null; // content script 未注入
  }
}

function render(status) {
  $('status').textContent = (status && statusText(status)) || '待機中';
  $('status').classList.toggle('error', status?.state === 'error');
  const active = status?.state === 'translating' || status?.state === 'done';
  $('translate').disabled = active;
  $('stop').disabled = !active;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const settings = await loadSettings(chrome.storage.local);
  $('provider').textContent = `${PROVIDER_LABELS[settings.provider]} / ${settings.providers[settings.provider].model}`;
  const res = await sendToTab({ type: 'status' });
  render(res?.status);
}

$('translate').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
  } catch {
    $('status').textContent = 'このページは翻訳できません（Chrome の内部ページなど）';
    $('status').classList.add('error');
    return;
  }
  const res = await sendToTab({ type: 'translate' });
  render(res?.status);
});

for (const type of ['stop', 'restore']) {
  $(type).addEventListener('click', async () => {
    const res = await sendToTab({ type });
    render(res?.status);
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'progress' && sender.tab?.id === tabId) render(message.status);
});

$('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
```

- [ ] **Step 3: 構文を確認**

Run: `node --check src/popup/popup.js && npm test`
Expected: エラーなし、PASS

- [ ] **Step 4: コミット**

```bash
git add src/popup
git commit -m "feat: add popup with translate, stop and restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 設定画面

**Files:**
- Create: `src/options/options.html`, `src/options/options.js`, `src/options/options.css`

**Interfaces:**
- Consumes: `loadSettings`, `saveSettings`, `mergeSettings`, `validateSettings`, `PROVIDER_IDS`, `PROVIDER_LABELS`（Task 2）; `isLocalUrl`（Task 1）; background の `testConnection` / `clearCache`（Task 8）
- Produces: なし（UI）。入力欄の `name` は設定オブジェクトのドット区切りパス（例: `providers.openai.apiKey`）。

`chrome.*` に依存するため単体テストはしない。動作確認は Task 15 の手動確認で行う。

- [ ] **Step 1: HTML と CSS を書く**

`src/options/options.html`:
```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>AI Page Translator 設定</title>
  <link rel="stylesheet" href="options.css">
</head>
<body>
  <main>
    <h1>AI Page Translator 設定</h1>
    <form id="form" novalidate>
      <label>プロバイダ <select name="provider" id="provider"></select></label>

      <fieldset data-provider="openai">
        <legend>OpenAI</legend>
        <label>APIキー <input name="providers.openai.apiKey" type="password" autocomplete="off"></label>
        <label>モデル <input name="providers.openai.model"></label>
      </fieldset>

      <fieldset data-provider="anthropic">
        <legend>Anthropic (Claude)</legend>
        <label>APIキー <input name="providers.anthropic.apiKey" type="password" autocomplete="off"></label>
        <label>モデル <input name="providers.anthropic.model"></label>
        <p class="hint">例: claude-opus-5-5（既定・高品質）、claude-haiku-5-5（低コスト）</p>
      </fieldset>

      <fieldset data-provider="gemini">
        <legend>Google Gemini</legend>
        <label>APIキー <input name="providers.gemini.apiKey" type="password" autocomplete="off"></label>
        <label>モデル <input name="providers.gemini.model"></label>
      </fieldset>

      <fieldset data-provider="compat">
        <legend>OpenAI互換 / ローカルLLM</legend>
        <label>ベースURL <input name="providers.compat.baseUrl" placeholder="http://localhost:11434/v1"></label>
        <label>APIキー（任意） <input name="providers.compat.apiKey" type="password" autocomplete="off"></label>
        <label>モデル <input name="providers.compat.model"></label>
        <label class="check"><input name="providers.compat.jsonMode" type="checkbox"> JSONモードを使う（response_format）</label>
        <p class="hint">Ollama: <code>http://localhost:11434/v1</code> / LM Studio: <code>http://localhost:1234/v1</code></p>
        <p class="hint">Ollama で 403 になる場合は、環境変数 <code>OLLAMA_ORIGINS=chrome-extension://*</code> を設定して Ollama を再起動してください。</p>
      </fieldset>

      <fieldset>
        <legend>翻訳</legend>
        <label>翻訳先言語 <input name="targetLang" required></label>
        <label>1バッチの最大段落数 <input name="maxUnitsPerBatch" type="number" min="1" max="200" required></label>
        <label>1バッチの最大文字数 <input name="maxCharsPerBatch" type="number" min="200" max="20000" required></label>
        <label>同時リクエスト数 <input name="concurrency" type="number" min="1" max="10" required></label>
      </fieldset>

      <div class="buttons">
        <button type="submit" class="primary">保存</button>
        <button type="button" id="test">接続テスト</button>
        <button type="button" id="clear-cache">キャッシュを消去</button>
      </div>
      <p id="message" role="status" aria-live="polite"></p>
    </form>
  </main>
  <script type="module" src="options.js"></script>
</body>
</html>
```

`src/options/options.css`:
```css
:root { color-scheme: light dark; --accent: #2563eb; }
body { margin: 0; font: 14px/1.6 system-ui, -apple-system, "Hiragino Sans", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 20px; margin: 0 0 16px; }
fieldset { margin: 0 0 16px; padding: 12px 14px; border: 1px solid #9ca3af; border-radius: 8px; }
legend { font-weight: 600; padding: 0 4px; }
label { display: block; margin: 0 0 10px; }
label input:not([type="checkbox"]), label select { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px; font: inherit; }
label.check input { margin-right: 6px; }
.hint { margin: 0 0 6px; font-size: 12px; color: GrayText; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; }
button { padding: 7px 14px; border: 1px solid #9ca3af; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
button.primary { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
#message { min-height: 1.6em; }
#message.error { color: #dc2626; }
```

- [ ] **Step 2: スクリプトを書く**

`src/options/options.js`:
```js
import { loadSettings, saveSettings, mergeSettings, validateSettings, PROVIDER_IDS, PROVIDER_LABELS } from '../lib/settings.js';
import { isLocalUrl } from '../lib/errors.js';

const form = document.getElementById('form');
const providerSelect = document.getElementById('provider');
const message = document.getElementById('message');
const fields = () => [...form.querySelectorAll('[name]')];

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

for (const id of PROVIDER_IDS) providerSelect.add(new Option(PROVIDER_LABELS[id], id));

function showProviderSection() {
  for (const fs of form.querySelectorAll('fieldset[data-provider]')) fs.hidden = fs.dataset.provider !== providerSelect.value;
}

function fill(settings) {
  for (const el of fields()) {
    const value = getPath(settings, el.name);
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  }
  showProviderSection();
}

function read() {
  const settings = mergeSettings({});
  for (const el of fields()) {
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    setPath(settings, el.name, value);
  }
  return settings;
}

function show(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

/** ユーザー操作の直後に同期的に呼ぶ（chrome.permissions.request はユーザー操作が必要） */
function requestHostPermission(settings) {
  if (settings.provider !== 'compat') return Promise.resolve(true);
  const origin = new URL(settings.providers.compat.baseUrl).origin;
  if (isLocalUrl(origin)) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

async function prepare() {
  if (!form.reportValidity()) return null;
  const settings = read();
  const invalid = validateSettings(settings);
  if (invalid) {
    show(invalid, true);
    return null;
  }
  if (!(await requestHostPermission(settings))) {
    show('ベースURLへのアクセスが許可されませんでした', true);
    return null;
  }
  return settings;
}

providerSelect.addEventListener('change', showProviderSection);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = await prepare();
  if (!settings) return;
  await saveSettings(chrome.storage.local, settings);
  show('保存しました');
});

document.getElementById('test').addEventListener('click', async () => {
  const settings = await prepare();
  if (!settings) return;
  show('接続テスト中…');
  const res = await chrome.runtime.sendMessage({ type: 'testConnection', settings });
  if (res?.ok) show(`接続成功: "Hello, world!" → "${res.sample}"`);
  else show(`接続失敗: ${res?.error?.message ?? '不明なエラー'}`, true);
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'clearCache' });
  if (res?.ok) show('キャッシュを消去しました');
  else show(`消去に失敗しました: ${res?.error?.message ?? '不明なエラー'}`, true);
});

fill(await loadSettings(chrome.storage.local));
```

- [ ] **Step 3: 構文を確認**

Run: `node --check src/options/options.js && npm test`
Expected: エラーなし、PASS

- [ ] **Step 4: コミット**

```bash
git add src/options
git commit -m "feat: add options page with connection test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: manifest、手動確認手順、README

**Files:**
- Create: `manifest.json`, `docs/manual-test.md`, `README.md`
- Test: `test/manifest.test.js`

**Interfaces:**
- Consumes: すべてのファイルパス（Task 8, 12, 13, 14）
- Produces: Chrome に読み込める拡張機能一式

- [ ] **Step 1: 失敗するテストを書く**

`test/manifest.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('manifest is MV3 and references existing files', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const path of [manifest.action.default_popup, manifest.options_page, manifest.background.service_worker, 'src/content.js']) {
    assert.ok(existsSync(join(root, path)), `${path} missing`);
  }
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'storage']);
  for (const host of ['https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*', 'http://localhost/*', 'http://127.0.0.1/*']) {
    assert.ok(manifest.host_permissions.includes(host), `${host} missing`);
  }
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
});

test('every module the content script loads is web accessible', () => {
  const patterns = manifest.web_accessible_resources.flatMap((r) => r.resources);
  assert.deepEqual(patterns, ['src/lib/*.js']);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const rel = relative(root, file);
    assert.match(rel, /^src\/lib\/[^/]+\.js$/, `${rel} is not covered by src/lib/*.js`);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/from\s+'(\.[^']+)'/g)) visit(resolve(dirname(file), spec));
  };
  visit(join(root, 'src/lib/page-translator.js'));
  visit(join(root, 'src/lib/status-overlay.js'));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`manifest.json` が存在しない）

- [ ] **Step 3: manifest を書く**

`manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "AI Page Translator",
  "version": "0.1.0",
  "description": "生成AI（OpenAI / Claude / Gemini / ローカルLLM）でWebページ全体を翻訳します",
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "AI Page Translator"
  },
  "options_page": "src/options/options.html",
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  },
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": [
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://generativelanguage.googleapis.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ],
  "optional_host_permissions": ["<all_urls>"],
  "web_accessible_resources": [
    {
      "resources": ["src/lib/*.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

- [ ] **Step 4: 成功を確認**

Run: `npm test`
Expected: PASS（全テスト）

- [ ] **Step 5: 手動確認手順を書く**

`docs/manual-test.md`:
```markdown
# 手動確認チェックリスト

## 準備
1. `chrome://extensions` を開き、右上の「デベロッパーモード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `ai-page-translator` フォルダを選ぶ
3. エラーが表示されないこと（「エラー」ボタンが出ていないこと）を確認する
4. 拡張機能の「詳細」→「拡張機能のオプション」で設定画面を開く

## 設定画面
- [ ] プロバイダを切り替えると、そのプロバイダの欄だけが表示される
- [ ] APIキー未入力で「保存」→「APIキーを設定してください」と表示される
- [ ] 正しいキーで「接続テスト」→「接続成功: "Hello, world!" → "こんにちは、世界！"」のように表示される
- [ ] 誤ったキーで「接続テスト」→「接続失敗: APIキーを確認してください (401)…」と表示される
- [ ] OpenAI互換でベースURLを `https://openrouter.ai/api/v1` にして保存 → アクセス許可のダイアログが出る
- [ ] 「キャッシュを消去」→「キャッシュを消去しました」

## 翻訳（少なくとも1つのクラウドAPIと Ollama で実施）
対象ページ: 英語版 Wikipedia の記事（例: https://en.wikipedia.org/wiki/Web_browser）、英語のニュースサイト、無限スクロールのページ（例: https://news.ycombinator.com を数ページ、または X/Reddit）

- [ ] ポップアップに「プロバイダ / モデル名」が表示される
- [ ] 「翻訳」→ 右下に「翻訳中… n/m」が出て、画面内の段落から日本語に置き換わる
- [ ] リンクが日本語になってもクリックで正しい遷移先に飛ぶ
- [ ] 太字・リンクを含む文の語順が自然な日本語になっている
- [ ] コード（`<code>`）、`<pre>` ブロック、入力欄の中身は翻訳されない
- [ ] タブのタイトルも翻訳される
- [ ] 完了すると「翻訳完了」になり、数秒後に表示が薄く小さくなる
- [ ] 下にスクロールして新しく読み込まれた内容も自動で翻訳される
- [ ] 「停止」→ 翻訳が止まり、以後追加された内容は翻訳されない
- [ ] 「原文に戻す」→ ページが元の英語に完全に戻る（タイトル含む）
- [ ] 同じページをもう一度翻訳すると、キャッシュにより API を呼ばずに速く終わる
- [ ] `chrome://extensions` などの内部ページで「翻訳」→「このページは翻訳できません」

## エラー
- [ ] 誤ったキーで翻訳 → 右下に赤い「エラー: APIキーを確認してください」が出て、ページは変わらない
- [ ] キーを直して再度「翻訳」→ 正常に翻訳される
- [ ] Ollama を停止して翻訳 → 数秒後に「ローカルLLMに接続できません。サーバーが起動しているか確認してください」
- [ ] 存在しないモデル名で翻訳 → 「リクエストが拒否されました (404)…」など、モデル名の確認を促す表示

## Ollama の準備（参考）
```sh
ollama pull llama3.2
# 403 が出る場合:
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"   # その後 Ollama を再起動
```
```

- [ ] **Step 6: README を書く**

`README.md`:
```markdown
# AI Page Translator

生成AIを使って Web ページ全体を翻訳する Chrome 拡張機能です。Google 翻訳の「ページ翻訳」のように、ページの文章を訳文に置き換えます。

## 対応プロバイダ
| プロバイダ | 既定モデル | 必要なもの |
|---|---|---|
| OpenAI | `gpt-5.5` | APIキー |
| Anthropic (Claude) | `claude-opus-5-5` | APIキー |
| Google Gemini | `gemini-3.8-flash` | APIキー |
| OpenAI互換 / ローカルLLM | `llama3.2`（Ollama） | ベースURL（APIキーは任意） |

OpenAI互換には Ollama（`http://localhost:11434/v1`）、LM Studio（`http://localhost:1234/v1`）、OpenRouter などを指定できます。モデル名は設定画面で自由に変更できます。

## インストール
1. `chrome://extensions` を開き「デベロッパーモード」をオン
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
3. 拡張機能のオプションでプロバイダ・APIキー・モデルを設定し「接続テスト」

## 使い方
ツールバーのアイコン → 「翻訳」。「停止」で翻訳を止め、「原文に戻す」で元のページに戻します。翻訳中に追加された内容（無限スクロールなど）も自動で翻訳します。

## プライバシー
APIキーと設定は `chrome.storage.local`（この端末のみ）に保存されます。ページの文章は、選んだプロバイダへの翻訳リクエストとしてのみ送信されます。

## 開発
```sh
npm install
npm test
```
設計: `docs/superpowers/specs/2026-10-13-ai-page-translator-design.md` / 手動確認: `docs/manual-test.md`
```

- [ ] **Step 7: 全体を確認**

Run: `npm test && for f in src/background.js src/content.js src/popup/popup.js src/options/options.js; do node --check "$f" || exit 1; done && echo ALL_OK`
Expected: 全テスト PASS、`ALL_OK`

- [ ] **Step 8: コミット**

```bash
git add manifest.json docs/manual-test.md README.md test/manifest.test.js
git commit -m "feat: add manifest, manual test checklist and README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: 手動確認**

`docs/manual-test.md` に沿って Chrome で確認する。拡張機能の読み込みと APIキーの入力はユーザーが行う。見つかった不具合は superpowers:systematic-debugging で調査してから修正する。
