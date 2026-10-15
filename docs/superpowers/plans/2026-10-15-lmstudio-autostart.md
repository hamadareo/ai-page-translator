# LM Studio Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「LM Studio（ローカル）」プロバイダを選んで「翻訳」を押すと、LM Studio のサーバーが止まっていても補助プログラム経由で起動・モデル読み込みを行い、そのまま翻訳する。

**Architecture:** 拡張機能の background が翻訳開始時（`getConfig`）に `ensureLmStudio` を1回実行する。サーバーが応答しなければ Chrome Native Messaging で Python 製の補助プログラムを呼び、補助プログラムが `lms server start` / `lms load <model> -y` を実行する。拡張機能 ID は manifest の `key` で固定し、`native-host/install.sh` がその ID を許可した登録ファイルを書く。

**Tech Stack:** 既存（Manifest V3、素の JS、`node --test` + jsdom）に加え、Python 3.8+ 標準ライブラリ（補助プログラムとその `unittest`）、POSIX sh（インストールスクリプト）、`openssl`（鍵生成、1回のみ）

**Spec:** `docs/superpowers/specs/2026-10-15-lmstudio-autostart-design.md`

## Global Constraints

- 対象 OS は macOS と Linux。Windows 用の補助プログラムは作らない。
- 補助プログラムは Python 3 標準ライブラリのみ（追加パッケージ禁止）。受け付ける命令は `status` / `list` / `ensure` の3つだけ。`subprocess.run(..., shell=False)` で引数リストを渡す。
- 補助プログラムの時間制限: `server start` 60 秒、`load` 120 秒、その他 15 秒。
- Native Messaging host 名: `com.aipagetranslator.lmstudio`。
- 拡張機能側の待ち時間: サーバー応答確認 2 秒、起動後の応答待ち最大 90 秒（1 秒間隔）。
- LM Studio の既定アドレス: `http://localhost:1234/v1`。自動起動の既定: オン。
- 秘密鍵 `extension-key.pem` はコミットしない。
- `src/lib/**` は `chrome.*` を参照しない（`sendNativeMessage` 等は注入）。
- UI 文言は日本語。メッセージ文言は仕様書 §5 の表のとおり。
- テスト: `npm test`（JS）と `npm run test:host`（Python）。Node は `PATH=~/.local/node/bin:$PATH` で実行。
- コミットメッセージ末尾に次の2行を付ける:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp`

## Review Focus

1. **Chrome は補助プログラムを最小限の PATH で起動する** → `python3` や `lms` が PATH になくても動くこと。テスト: Task 3「find_lms finds the LM Studio CLI with an empty PATH」、起動用スクリプトは Python の絶対パスを使う（Task 4）。
2. **`-` で始まる、または存在しないモデル名**（例: `--port`）→ `lms` のオプションとして解釈されず `model_not_found` になること。テスト: Task 3「test_ensure_rejects_option_like_model」。
3. **サーバーが既に起動している**（別アプリが起動済み）→ 補助プログラムが再起動を試みないこと。テスト: Task 3「test_ensure_running_and_loaded_does_nothing」。
4. **壊れたメッセージ**（長さヘッダーと本文の不一致、不正な JSON）→ 補助プログラムが落ちずに `bad_request` を返すこと。テスト: Task 3「test_main_replies_bad_request_on_garbage」。
5. **`lms` が JSON 以外を出力する**（古い LM Studio）→ `lms_failed` として分かるメッセージを返すこと。テスト: Task 3「test_non_json_output」。

---

## File Structure

```
manifest.json                       # Task 4: nativeMessaging 権限, key
.gitignore                          # Task 4: extension-key.pem
package.json                        # Task 3: test:host スクリプト
native-host/
├── lmstudio_host.py                # Task 3
├── test_lmstudio_host.py           # Task 3
├── extension_id.py                 # Task 4: manifest の key から ID を計算
├── install.sh / uninstall.sh       # Task 4
src/lib/settings.js                 # Task 1
src/lib/providers/lmstudio.js       # Task 1
src/lib/providers/index.js          # Task 1
src/lib/lmstudio.js                 # Task 2: ensureLmStudio, listLmStudioModels
src/lib/page-translator.js          # Task 5: setPhase
src/lib/status-overlay.js           # Task 5: phase 表示
src/content.js                      # Task 5: phase メッセージ
src/background.js                   # Task 6
src/options/options.{html,js}       # Task 7
README.md, docs/manual-test.md      # Task 8
```

---

### Task 1: 設定とプロバイダ `lmstudio`

**Files:**
- Modify: `src/lib/settings.js`, `src/lib/providers/index.js`
- Create: `src/lib/providers/lmstudio.js`
- Test: `test/settings.test.js`, `test/providers.test.js`

**Interfaces:**
- Produces: `PROVIDER_IDS` に `'lmstudio'`（末尾）、`PROVIDER_LABELS.lmstudio = 'LM Studio（ローカル）'`、`DEFAULT_SETTINGS.providers.lmstudio = { model: '', baseUrl: 'http://localhost:1234/v1', autoStart: true }`、`PROVIDERS.lmstudio`（`buildRequest`/`extractText`）

- [ ] **Step 1: 失敗するテストを書く**

`test/settings.test.js` の既存テスト `defaults match the spec` の `PROVIDER_IDS` 行を次に置き換える:
```js
  assert.deepEqual(PROVIDER_IDS, ['openai', 'anthropic', 'gemini', 'compat', 'lmstudio']);
```
末尾に追加:
```js
test('lmstudio defaults and validation', () => {
  const s = mergeSettings({ provider: 'lmstudio' });
  assert.deepEqual(s.providers.lmstudio, { model: '', baseUrl: 'http://localhost:1234/v1', autoStart: true });
  assert.equal(PROVIDER_LABELS.lmstudio, 'LM Studio（ローカル）');
  assert.match(validateSettings(s), /モデル/);
  assert.equal(validateSettings(mergeSettings({ provider: 'lmstudio', providers: { lmstudio: { model: 'qwen/qwen2.5-coder-14b' } } })), null, 'no API key needed');
  assert.match(validateSettings(mergeSettings({ provider: 'lmstudio', providers: { lmstudio: { model: 'm', baseUrl: 'ftp://x' } } })), /ベースURL/);
});
```
`test/providers.test.js` 末尾に追加:
```js
test('lmstudio request uses its base URL, no key and no JSON mode', () => {
  const { url, init } = PROVIDERS.lmstudio.buildRequest(['Hi'], '日本語', { model: 'qwen/qwen2.5-coder-14b', baseUrl: 'http://localhost:1234/v1', autoStart: true });
  assert.equal(url, 'http://localhost:1234/v1/chat/completions');
  assert.equal('Authorization' in init.headers, false);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'qwen/qwen2.5-coder-14b');
  assert.equal('response_format' in body, false);
  assert.equal(PROVIDERS.lmstudio.extractText({ choices: [{ message: { content: 'x' } }] }), 'x');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (pass|fail)|✖ "`
Expected: FAIL（`defaults match the spec`、`lmstudio defaults and validation`、`lmstudio request ...`）

- [ ] **Step 3: 実装する**

`src/lib/settings.js`:
- `export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'compat', 'lmstudio'];`
- `PROVIDER_LABELS` に `lmstudio: 'LM Studio（ローカル）',` を追加
- `DEFAULT_SETTINGS.providers` に `lmstudio: { model: '', baseUrl: 'http://localhost:1234/v1', autoStart: true },` を追加
- `validateSettings` の APIキー判定とベースURL判定を次に置き換える:
```js
/** APIキーが不要で、ベースURLを持つプロバイダ */
const LOCAL_PROVIDERS = new Set(['compat', 'lmstudio']);
```
（ファイル先頭の定数群の下に置く）
```js
  if (!LOCAL_PROVIDERS.has(s.provider) && !p.apiKey?.trim()) return 'APIキーを設定してください';
  if (LOCAL_PROVIDERS.has(s.provider)) {
    let url;
    try {
      url = new URL(p.baseUrl);
    } catch {
      return 'ベースURLが不正です';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ベースURLが不正です';
  }
```

`src/lib/providers/lmstudio.js`:
```js
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
```

`src/lib/providers/index.js`: `import { lmstudioProvider } from './lmstudio.js';` を追加し、`PROVIDERS` に `lmstudio: lmstudioProvider,` を追加。

- [ ] **Step 4: 成功を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: PASS（fail 0）

- [ ] **Step 5: コミット**

```bash
git add src/lib/settings.js src/lib/providers test/settings.test.js test/providers.test.js
git commit -m "feat: add LM Studio provider settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 2: 起動の段取り `ensureLmStudio`

**Files:**
- Create: `src/lib/lmstudio.js`
- Test: `test/lmstudio.test.js`

**Interfaces:**
- Consumes: `TranslationError`（`src/lib/errors.js`）、`defaultSleep`（`src/lib/retry.js`）
- Produces:
  - `NATIVE_HOST = 'com.aipagetranslator.lmstudio'`
  - `portOf(baseUrl: string): number`
  - `ensureLmStudio(config: {model, baseUrl, autoStart}, { fetch?, sendNativeMessage, sleep?, now?, onProgress?, startWaitMs? }): Promise<{started: boolean, loaded: boolean}>`（失敗時 `TranslationError`）
  - `listLmStudioModels({ sendNativeMessage }): Promise<{key: string, name: string}[]>`
  - `sendNativeMessage(host: string, message: object): Promise<object>`（background が `chrome.runtime.sendNativeMessage` を渡す）

- [ ] **Step 1: 失敗するテストを書く**

`test/lmstudio.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLmStudio, listLmStudioModels, NATIVE_HOST, portOf } from '../src/lib/lmstudio.js';

const config = { model: 'qwen/qwen2.5-coder-14b', baseUrl: 'http://localhost:1234/v1', autoStart: true };

/** The server answers /models after `failures` failed probes. */
function fakeServer(failures = 0) {
  let probes = 0;
  const fetch = async (url) => {
    probes++;
    assert.equal(url, 'http://localhost:1234/v1/models');
    if (probes > failures) return new Response('{"data":[]}', { status: 200 });
    throw new TypeError('Failed to fetch');
  };
  fetch.probes = () => probes;
  return fetch;
}

function fakeHost(reply) {
  const calls = [];
  const send = async (host, message) => {
    calls.push({ host, message });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  send.calls = calls;
  return send;
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const HELPER_MISSING = new Error('Specified native messaging host not found.');

test('does nothing when auto start is off', async () => {
  const fetch = fakeServer();
  const send = fakeHost({ ok: true });
  assert.deepEqual(await ensureLmStudio({ ...config, autoStart: false }, { fetch, sendNativeMessage: send }), { started: false, loaded: false });
  assert.equal(fetch.probes(), 0);
  assert.equal(send.calls.length, 0);
});

test('server already up: only asks the helper to make sure the model is loaded', async () => {
  const progress = [];
  const send = fakeHost({ ok: true, started: false, loaded: true });
  const result = await ensureLmStudio(config, { fetch: fakeServer(), sendNativeMessage: send, onProgress: (t) => progress.push(t), ...fakeClock() });
  assert.deepEqual(result, { started: false, loaded: true });
  assert.deepEqual(send.calls, [{ host: NATIVE_HOST, message: { cmd: 'ensure', model: config.model, port: 1234 } }]);
  assert.deepEqual(progress, ['モデルを読み込んでいます…']);
});

test('server down: starts it through the helper and waits until it answers', async () => {
  const progress = [];
  const fetch = fakeServer(3);
  const send = fakeHost({ ok: true, started: true, loaded: true });
  const result = await ensureLmStudio(config, { fetch, sendNativeMessage: send, onProgress: (t) => progress.push(t), ...fakeClock() });
  assert.deepEqual(result, { started: true, loaded: true });
  assert.equal(send.calls.length, 1);
  assert.equal(fetch.probes(), 4);
  assert.equal(progress[0], 'LM Studio を起動しています…');
});

test('server down and helper not installed: config error with install guidance', async () => {
  await assert.rejects(
    ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost(HELPER_MISSING), ...fakeClock() }),
    (e) => e.kind === 'config' && /補助プログラムのインストール/.test(e.message),
  );
});

test('server up and helper not installed: continue and let LM Studio load the model on demand', async () => {
  const result = await ensureLmStudio(config, { fetch: fakeServer(), sendNativeMessage: fakeHost(HELPER_MISSING), ...fakeClock() });
  assert.deepEqual(result, { started: false, loaded: false });
});

test('helper errors become clear messages', async () => {
  const run = (error) => ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost({ ok: false, error }), ...fakeClock() });
  await assert.rejects(run({ kind: 'lms_not_found' }), (e) => e.kind === 'config' && /LM Studio が見つかりません/.test(e.message));
  await assert.rejects(run({ kind: 'model_not_found' }), (e) => e.kind === 'config' && e.message.includes(config.model));
  await assert.rejects(run({ kind: 'load_failed', message: 'out of memory' }), (e) => e.kind === 'config' && /out of memory/.test(e.message));
  await assert.rejects(run({ kind: 'timeout', step: 'load' }), (e) => e.kind === 'network' && /時間がかかっています/.test(e.message));
  await assert.rejects(run({ kind: 'start_failed', message: 'port busy' }), (e) => e.kind === 'config' && /port busy/.test(e.message));
});

test('gives up waiting for the server after the deadline', async () => {
  await assert.rejects(
    ensureLmStudio(config, { fetch: fakeServer(Infinity), sendNativeMessage: fakeHost({ ok: true, started: true, loaded: true }), startWaitMs: 5000, ...fakeClock() }),
    (e) => e.kind === 'network' && /時間がかかっています/.test(e.message),
  );
});

test('portOf', () => {
  assert.equal(portOf('http://localhost:1234/v1'), 1234);
  assert.equal(portOf('http://127.0.0.1/v1'), 80);
  assert.equal(portOf('https://lm.example/v1'), 443);
});

test('listLmStudioModels returns the helper list and maps errors', async () => {
  const models = [{ key: 'qwen/qwen2.5-coder-14b', name: 'Qwen2.5 Coder 14B' }];
  assert.deepEqual(await listLmStudioModels({ sendNativeMessage: fakeHost({ ok: true, models }) }), models);
  await assert.rejects(listLmStudioModels({ sendNativeMessage: fakeHost(HELPER_MISSING) }), (e) => e.kind === 'config' && /補助プログラム/.test(e.message));
  await assert.rejects(listLmStudioModels({ sendNativeMessage: fakeHost({ ok: false, error: { kind: 'lms_not_found' } }) }), /LM Studio が見つかりません/);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (pass|fail)|Cannot find module"`
Expected: FAIL（`Cannot find module .../src/lib/lmstudio.js`）

- [ ] **Step 3: 実装する**

`src/lib/lmstudio.js`:
```js
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
```

- [ ] **Step 4: 成功を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: PASS（fail 0）

- [ ] **Step 5: コミット**

```bash
git add src/lib/lmstudio.js test/lmstudio.test.js
git commit -m "feat: start LM Studio through the native helper before translating" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 3: 補助プログラム `lmstudio_host.py`

**Files:**
- Create: `native-host/lmstudio_host.py`, `native-host/test_lmstudio_host.py`
- Modify: `package.json`（`test:host` スクリプト）

**Interfaces:**
- Produces（Task 2 が前提とする応答）:
  - `{"cmd": "status"}` → `{"ok": true, "lms": true, "running": bool, "port": int|null}`
  - `{"cmd": "list"}` → `{"ok": true, "models": [{"key", "name"}]}`
  - `{"cmd": "ensure", "model": str, "port": int}` → `{"ok": true, "started": bool, "loaded": bool}`
  - エラー: `{"ok": false, "error": {"kind": "bad_command"|"bad_request"|"lms_not_found"|"model_not_found"|"timeout"|"start_failed"|"load_failed"|"lms_failed"|"internal", "message": str, ...}}`（`timeout` は `step` を含む）
  - Python 関数: `find_lms(home=None, which=shutil.which)`, `read_message(stream)`, `write_message(stream, obj)`, `handle(message, lms, runner=subprocess.run)`, `main(stdin=None, stdout=None)`, `class HostError(kind, message='', **extra)`

- [ ] **Step 1: 失敗するテストを書く**

`native-host/test_lmstudio_host.py`:
```python
import io
import json
import os
import stat
import struct
import subprocess
import tempfile
import unittest

import lmstudio_host as host

MODEL = 'qwen/qwen2.5-coder-14b'
LS = json.dumps([
    {'type': 'llm', 'modelKey': MODEL, 'displayName': 'Qwen2.5 Coder 14B'},
    {'type': 'embedding', 'modelKey': 'text-embedding-nomic-embed-text-v1.5'},
])


def frame(obj):
    data = json.dumps(obj).encode('utf-8')
    return struct.pack('=I', len(data)) + data


class FakeRunner:
    """Stands in for subprocess.run. responses: 'joined args' -> (code, stdout, stderr) or an exception."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        out = self.responses.get(' '.join(argv[1:]), (0, '', ''))
        if isinstance(out, BaseException):
            raise out
        code, stdout, stderr = out
        return subprocess.CompletedProcess(argv, code, stdout, stderr)

    def commands(self):
        return [' '.join(argv[1:]) for argv, _ in self.calls]


def ensure(runner, **message):
    return host.handle({'cmd': 'ensure', 'model': MODEL, 'port': 1234, **message}, lms='/x/lms', runner=runner)


class MessagingTest(unittest.TestCase):
    def test_read_write_roundtrip(self):
        out = io.BytesIO()
        host.write_message(out, {'ok': True, 'text': '日本語'})
        self.assertEqual(host.read_message(io.BytesIO(out.getvalue())), {'ok': True, 'text': '日本語'})

    def test_main_replies_bad_request_on_garbage(self):
        for raw in (struct.pack('=I', 50) + b'{"cmd"', struct.pack('=I', 5) + b'nope!', b'\x01'):
            out = io.BytesIO()
            host.main(stdin=io.BytesIO(raw), stdout=out)
            reply = host.read_message(io.BytesIO(out.getvalue()))
            self.assertEqual(reply['ok'], False)
            self.assertEqual(reply['error']['kind'], 'bad_request')


class CommandTest(unittest.TestCase):
    def test_bad_command(self):
        with self.assertRaises(host.HostError) as ctx:
            host.handle({'cmd': 'rm -rf /'}, lms='/x/lms', runner=FakeRunner({}))
        self.assertEqual(ctx.exception.kind, 'bad_command')

    def test_lms_not_found(self):
        with self.assertRaises(host.HostError) as ctx:
            host.handle({'cmd': 'list'}, lms=None, runner=FakeRunner({}))
        self.assertEqual(ctx.exception.kind, 'lms_not_found')

    def test_list_only_llms(self):
        reply = host.handle({'cmd': 'list'}, lms='/x/lms', runner=FakeRunner({'ls --json': (0, LS, '')}))
        self.assertEqual(reply, {'ok': True, 'models': [{'key': MODEL, 'name': 'Qwen2.5 Coder 14B'}]})

    def test_status(self):
        runner = FakeRunner({'server status --json': (0, '{"running":false,"port":1234}', '')})
        self.assertEqual(host.handle({'cmd': 'status'}, lms='/x/lms', runner=runner), {'ok': True, 'lms': True, 'running': False, 'port': 1234})

    def test_ensure_rejects_option_like_model(self):
        for model in ('--port', 'unknown/model'):
            with self.assertRaises(host.HostError) as ctx:
                ensure(FakeRunner({'ls --json': (0, LS, '')}), model=model)
            self.assertEqual(ctx.exception.kind, 'model_not_found')

    def test_ensure_rejects_bad_port(self):
        for port in (0, 70000, '1234', True, None):
            with self.assertRaises(host.HostError) as ctx:
                ensure(FakeRunner({'ls --json': (0, LS, '')}), port=port)
            self.assertEqual(ctx.exception.kind, 'bad_request')

    def test_ensure_starts_and_loads(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":false,"port":1234}', ''),
            'ps --json': (0, '[]', ''),
        })
        self.assertEqual(ensure(runner), {'ok': True, 'started': True, 'loaded': True})
        self.assertIn('server start --port 1234', runner.commands())
        self.assertIn(f'load {MODEL} -y', runner.commands())
        for argv, kwargs in runner.calls:
            self.assertIsInstance(argv, list)
            self.assertIs(kwargs.get('shell'), False)
            self.assertIn('timeout', kwargs)

    def test_ensure_running_and_loaded_does_nothing(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":true,"port":1234}', ''),
            'ps --json': (0, json.dumps([{'modelKey': MODEL, 'identifier': MODEL}]), ''),
        })
        self.assertEqual(ensure(runner), {'ok': True, 'started': False, 'loaded': False})
        self.assertFalse(any(c.startswith('server start') or c.startswith('load') for c in runner.commands()))

    def test_timeout(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":true,"port":1234}', ''),
            'ps --json': (0, '[]', ''),
            f'load {MODEL} -y': subprocess.TimeoutExpired('lms', 120),
        })
        with self.assertRaises(host.HostError) as ctx:
            ensure(runner)
        self.assertEqual(ctx.exception.kind, 'timeout')
        self.assertEqual(ctx.exception.to_dict()['step'], 'load')

    def test_load_failed_message(self):
        runner = FakeRunner({
            'ls --json': (0, LS, ''),
            'server status --json': (0, '{"running":true,"port":1234}', ''),
            'ps --json': (0, '[]', ''),
            f'load {MODEL} -y': (1, '', 'Error: not enough memory'),
        })
        with self.assertRaises(host.HostError) as ctx:
            ensure(runner)
        self.assertEqual(ctx.exception.kind, 'load_failed')
        self.assertIn('not enough memory', ctx.exception.message)

    def test_non_json_output(self):
        with self.assertRaises(host.HostError) as ctx:
            host.handle({'cmd': 'list'}, lms='/x/lms', runner=FakeRunner({'ls --json': (0, 'You have 2 models', '')}))
        self.assertEqual(ctx.exception.kind, 'lms_failed')


class FindLmsTest(unittest.TestCase):
    def test_find_lms_finds_the_lm_studio_cli_with_an_empty_path(self):
        with tempfile.TemporaryDirectory() as home:
            path = os.path.join(home, '.lmstudio', 'bin', 'lms')
            os.makedirs(os.path.dirname(path))
            with open(path, 'w') as f:
                f.write('#!/bin/sh\n')
            os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
            self.assertEqual(host.find_lms(home=home, which=lambda name: None), path)

    def test_find_lms_falls_back_to_path_then_none(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(host.find_lms(home=home, which=lambda name: '/usr/local/bin/lms'), '/usr/local/bin/lms')
            self.assertIsNone(host.find_lms(home=home, which=lambda name: None))


if __name__ == '__main__':
    unittest.main()
```

`package.json` の `scripts` に追加:
```json
    "test:host": "python3 -m unittest discover -s native-host -p 'test_*.py'"
```

- [ ] **Step 2: 失敗を確認**

Run: `cd ~/ai-page-translator && npm run test:host 2>&1 | tail -5`（npm は `PATH=~/.local/node/bin:$PATH` 付き）
Expected: FAIL（`ModuleNotFoundError: No module named 'lmstudio_host'`）

- [ ] **Step 3: 実装する**

`native-host/lmstudio_host.py`:
```python
#!/usr/bin/env python3
"""Chrome Native Messaging host: lets AI Page Translator start LM Studio and load a model.

Accepts exactly three commands (status, list, ensure) and runs the LM Studio CLI `lms`
with an argument list (never through a shell).
"""
import json
import os
import shutil
import struct
import subprocess
import sys

TIMEOUTS = {'start': 60, 'load': 120, 'default': 15}
COMMANDS = ('status', 'list', 'ensure')


class HostError(Exception):
    def __init__(self, kind, message='', **extra):
        super().__init__(message or kind)
        self.kind = kind
        self.message = message
        self.extra = extra

    def to_dict(self):
        return {'kind': self.kind, 'message': self.message, **self.extra}


def find_lms(home=None, which=shutil.which):
    home = home or os.path.expanduser('~')
    candidate = os.path.join(home, '.lmstudio', 'bin', 'lms')
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return which('lms')


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        raise HostError('bad_request', 'missing length header')
    (length,) = struct.unpack('=I', header)
    body = stream.read(length)
    if len(body) < length:
        raise HostError('bad_request', 'message shorter than its header')
    try:
        return json.loads(body.decode('utf-8'))
    except ValueError:
        raise HostError('bad_request', 'invalid JSON')


def write_message(stream, message):
    data = json.dumps(message, ensure_ascii=False).encode('utf-8')
    stream.write(struct.pack('=I', len(data)))
    stream.write(data)
    stream.flush()


def run(lms, args, runner, step='default'):
    try:
        return runner([lms, *args], capture_output=True, text=True, timeout=TIMEOUTS[step], shell=False)
    except subprocess.TimeoutExpired:
        raise HostError('timeout', f'lms {" ".join(args)} timed out', step=step)


def run_json(lms, args, runner):
    result = run(lms, args, runner)
    if result.returncode != 0:
        raise HostError('lms_failed', (result.stderr or result.stdout or '')[:300])
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise HostError('lms_failed', 'unexpected output from lms: ' + (result.stdout or '')[:100])


def llm_models(lms, runner):
    return [m for m in run_json(lms, ['ls', '--json'], runner) if m.get('type') == 'llm']


def handle(message, lms, runner=subprocess.run):
    if not isinstance(message, dict):
        raise HostError('bad_request', 'message must be an object')
    cmd = message.get('cmd')
    if cmd not in COMMANDS:
        raise HostError('bad_command', str(cmd)[:50])
    if lms is None:
        raise HostError('lms_not_found')

    if cmd == 'status':
        status = run_json(lms, ['server', 'status', '--json'], runner)
        return {'ok': True, 'lms': True, 'running': bool(status.get('running')), 'port': status.get('port')}

    if cmd == 'list':
        models = llm_models(lms, runner)
        return {'ok': True, 'models': [{'key': m['modelKey'], 'name': m.get('displayName') or m['modelKey']} for m in models]}

    model = message.get('model')
    port = message.get('port')
    if not isinstance(model, str) or not model:
        raise HostError('bad_request', 'model is required')
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise HostError('bad_request', 'port must be an integer between 1 and 65535')
    if model not in {m['modelKey'] for m in llm_models(lms, runner)}:
        raise HostError('model_not_found', model)

    started = False
    if not run_json(lms, ['server', 'status', '--json'], runner).get('running'):
        result = run(lms, ['server', 'start', '--port', str(port)], runner, step='start')
        if result.returncode != 0:
            raise HostError('start_failed', (result.stderr or result.stdout or '')[:300])
        started = True

    loaded_now = False
    loaded = run_json(lms, ['ps', '--json'], runner)
    if model not in {m.get('modelKey') for m in loaded} | {m.get('identifier') for m in loaded}:
        result = run(lms, ['load', model, '-y'], runner, step='load')
        if result.returncode != 0:
            raise HostError('load_failed', (result.stderr or result.stdout or '')[:300])
        loaded_now = True
    return {'ok': True, 'started': started, 'loaded': loaded_now}


def main(stdin=None, stdout=None):
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    try:
        reply = handle(read_message(stdin), lms=find_lms())
    except HostError as err:
        reply = {'ok': False, 'error': err.to_dict()}
    except Exception as err:  # never crash: Chrome would only see "native host has exited"
        reply = {'ok': False, 'error': {'kind': 'internal', 'message': str(err)[:300]}}
    write_message(stdout, reply)


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: 成功を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm run test:host 2>&1 | tail -4`
Expected: `OK`（15 tests）

- [ ] **Step 5: コミット**

```bash
git add native-host/lmstudio_host.py native-host/test_lmstudio_host.py package.json
git commit -m "feat: add LM Studio native messaging helper" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 4: 拡張機能 ID の固定とインストールスクリプト

**Files:**
- Modify: `manifest.json`, `.gitignore`, `test/manifest.test.js`
- Create: `native-host/extension_id.py`, `native-host/install.sh`, `native-host/uninstall.sh`

**Interfaces:**
- Consumes: Task 3 の `native-host/lmstudio_host.py`
- Produces: 固定の拡張機能 ID（`python3 native-host/extension_id.py manifest.json` で得られる）。環境変数 `CHROME_NMH_DIR` で登録先フォルダを差し替えられる `install.sh`（Task 8 の検証用 Chrome で使う）

- [ ] **Step 1: 失敗するテストを書く**

`test/manifest.test.js` の権限の行を置き換え、テストを追加:
```js
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'nativeMessaging', 'scripting', 'storage', 'unlimitedStorage']);
```
```js
test('manifest pins the extension ID with a public key', () => {
  assert.match(manifest.key, /^[A-Za-z0-9+/]{300,}={0,2}$/);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (pass|fail)|✖ "`
Expected: FAIL（権限と `key`）

- [ ] **Step 3: 鍵を作って manifest に入れる**

```bash
cd ~/ai-page-translator
printf 'extension-key.pem\n' >> .gitignore
openssl genrsa -out extension-key.pem 2048
KEY=$(openssl rsa -in extension-key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A)
python3 - "$KEY" <<'EOF'
import json, sys
m = json.load(open('manifest.json'))
m['key'] = sys.argv[1]
m['permissions'] = ['activeTab', 'scripting', 'storage', 'unlimitedStorage', 'nativeMessaging']
json.dump(m, open('manifest.json', 'w'), ensure_ascii=False, indent=2)
open('manifest.json', 'a').write('\n')
EOF
```

`native-host/extension_id.py`:
```python
#!/usr/bin/env python3
"""Print the Chrome extension ID derived from manifest.json's "key" (SHA-256 of the DER key, a-p alphabet)."""
import base64
import hashlib
import json
import sys

with open(sys.argv[1], encoding='utf-8') as f:
    key = json.load(f)['key']
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
```

`native-host/install.sh`:
```sh
#!/bin/sh
# AI Page Translator の LM Studio 自動起動用補助プログラムを Chrome に登録する（macOS / Linux）
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
NAME=com.aipagetranslator.lmstudio

PY=$(command -v python3 || true)
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  echo "Python 3.8 以上が必要です。https://www.python.org/downloads/ からインストールしてから、もう一度実行してください。" >&2
  exit 1
fi
PY=$("$PY" -c 'import sys; print(sys.executable)')

EXT_ID=$("$PY" "$HERE/extension_id.py" "$HERE/../manifest.json")
DEST="$HOME/.local/share/ai-page-translator"
mkdir -p "$DEST"
cp "$HERE/lmstudio_host.py" "$DEST/lmstudio_host.py"
cat > "$DEST/lmstudio_host" <<EOF
#!/bin/sh
exec "$PY" "$DEST/lmstudio_host.py" "\$@"
EOF
chmod 755 "$DEST/lmstudio_host"

if [ -n "${CHROME_NMH_DIR:-}" ]; then
  DIR="$CHROME_NMH_DIR"
elif [ "$(uname)" = Darwin ]; then
  DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi
mkdir -p "$DIR"
cat > "$DIR/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "AI Page Translator - LM Studio launcher",
  "path": "$DEST/lmstudio_host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "インストールしました（拡張機能 ID: $EXT_ID）。Chrome で拡張機能を再読み込みしてください。"
```

`native-host/uninstall.sh`:
```sh
#!/bin/sh
# install.sh で登録した補助プログラムを削除する
set -eu
NAME=com.aipagetranslator.lmstudio
if [ -n "${CHROME_NMH_DIR:-}" ]; then
  DIR="$CHROME_NMH_DIR"
elif [ "$(uname)" = Darwin ]; then
  DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi
rm -f "$DIR/$NAME.json"
rm -rf "$HOME/.local/share/ai-page-translator"
echo "削除しました。"
```

```bash
chmod 755 native-host/install.sh native-host/uninstall.sh native-host/extension_id.py native-host/lmstudio_host.py
```

- [ ] **Step 4: 成功を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && python3 native-host/extension_id.py manifest.json && git status --short | grep -c pem || true`
Expected: PASS（fail 0）、32 文字の a〜p の ID が表示される、`extension-key.pem` は git に出ない（`0`）

インストールスクリプトの動作を一時フォルダで確かめる（普段の Chrome には書き込まない）:
Run: `T=$(mktemp -d) && CHROME_NMH_DIR=$T HOME=$T sh native-host/install.sh && cat "$T/com.aipagetranslator.lmstudio.json" && printf '\015\000\000\000{"cmd":"bad"}' | "$T/.local/share/ai-page-translator/lmstudio_host" | tail -c +5; echo; rm -rf "$T"`
Expected: 登録ファイルの JSON（`allowed_origins` に上の ID）と、`{"ok": false, "error": {"kind": "bad_command", ...}}`

- [ ] **Step 5: コミット**

```bash
git add manifest.json .gitignore test/manifest.test.js native-host/extension_id.py native-host/install.sh native-host/uninstall.sh
git commit -m "feat: pin the extension ID and add helper install scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 5: 待機中の状態表示（phase）

**Files:**
- Modify: `src/lib/page-translator.js`, `src/lib/status-overlay.js`, `src/content.js`
- Test: `test/page-translator.test.js`, `test/status-overlay.test.js`

**Interfaces:**
- Produces: `createPageTranslator(...)` の戻り値に `setPhase(text: string|null): void`。`Status` に `phase: string|null`。content script は `{ type: 'phase', text }` を受けて `setPhase(text)` を呼ぶ。`statusText` は `translating` かつ `phase` があれば `phase` を返す。

- [ ] **Step 1: 失敗するテストを書く**

`test/page-translator.test.js` の `translates body and title, keeping elements` の期待値を次に置き換える:
```js
  assert.deepEqual(status, { state: 'done', done: 3, total: 3, failed: 0, error: null, phase: null });
```
末尾に追加:
```js
test('setPhase shows a phase while waiting for getConfig and clears it afterwards', async () => {
  const { window, document } = makeDocument('<p>One</p>');
  let release;
  const gate = new Promise((r) => { release = r; });
  const statuses = [];
  const pt = createPageTranslator({
    document,
    MutationObserverImpl: window.MutationObserver,
    debounceMs: 10,
    onStatus: (s) => statuses.push(s),
    sendMessage: async (msg) => {
      if (msg.type === 'getConfig') {
        await gate;
        return { ok: true, maxUnitsPerBatch: 40, maxCharsPerBatch: 3000, concurrency: 1 };
      }
      return { ok: true, translations: msg.texts.map((t) => `[ja]${t}`) };
    },
  });
  const done = pt.translate();
  await sleep(5);
  pt.setPhase('LM Studio を起動しています…');
  assert.equal(pt.getStatus().phase, 'LM Studio を起動しています…');
  release();
  await done;
  assert.equal(pt.getStatus().phase, null);
  assert.ok(statuses.some((s) => s.phase === 'LM Studio を起動しています…'));
  pt.stop();
});

test('setPhase is ignored when not translating', () => {
  const { document } = makeDocument('<p>One</p>');
  const pt = createPageTranslator({ document, sendMessage: async () => ({ ok: true }) });
  pt.setPhase('x');
  assert.equal(pt.getStatus().phase, null);
});
```
`test/status-overlay.test.js` 末尾に追加:
```js
test('statusText shows the phase while translating', () => {
  assert.equal(statusText({ ...base, state: 'translating', phase: 'LM Studio を起動しています…' }), 'LM Studio を起動しています…');
  assert.equal(statusText({ ...base, state: 'translating', phase: null, done: 1, total: 2 }), '翻訳中… 1/2');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (pass|fail)|✖ "`
Expected: FAIL（上記4件）

- [ ] **Step 3: 実装する**

`src/lib/page-translator.js`:
- 初期状態: `let status = { state: 'idle', done: 0, total: 0, failed: 0, error: null, phase: null };`
- `fail(error)` の `emit` を `emit({ state: 'error', error, phase: null });` にする
- `translate()` の開始時の `emit` を `emit({ state: 'translating', done: 0, total: 0, failed: 0, error: null, phase: null });` にし、`config = res;` の直後に `emit({ phase: null });` を追加
- `restore()` の `emit` を `emit({ state: 'idle', done: 0, total: 0, failed: 0, error: null, phase: null });` にする
- 関数を追加して戻り値に含める:
```js
  /** 翻訳の準備中（LM Studio の起動待ちなど）の状況を表示する */
  function setPhase(text) {
    if (status.state !== 'translating') return;
    emit({ phase: text ?? null });
  }

  return { translate, stop, restore, setPhase, getStatus: () => status };
```

`src/lib/status-overlay.js` の `statusText`:
```js
    case 'translating':
      return status.phase || `翻訳中… ${status.done}/${status.total}`;
```

`src/content.js`: `actions` の各関数が message も受け取れるようにし、`phase` を追加:
```js
    phase: (t, message) => {
      t.setPhase(message.text);
      return t.getStatus();
    },
```
リスナーの呼び出しを `(translator) => sendResponse({ ok: true, status: action(translator, message) })` に変更。

- [ ] **Step 4: 成功を確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && ~/.local/node/bin/node --check src/content.js`
Expected: PASS（fail 0）、構文エラーなし

- [ ] **Step 5: コミット**

```bash
git add src/lib/page-translator.js src/lib/status-overlay.js src/content.js test/page-translator.test.js test/status-overlay.test.js
git commit -m "feat: show a preparation phase while translation is starting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 6: background の配線

**Files:**
- Modify: `src/background.js`

**Interfaces:**
- Consumes: `ensureLmStudio`, `listLmStudioModels`（Task 2）、`setPhase` 経由の `{ type: 'phase', text }`（Task 5）
- Produces: メッセージ `{ type: 'listLmStudioModels' }` → `{ ok: true, models }`。`getConfig` / `testConnection` はプロバイダが `lmstudio` のとき先に `ensureLmStudio` を実行する。

`chrome.*` に依存するため単体テストはしない（Task 8 の実機確認で確かめる）。

- [ ] **Step 1: 実装する**

`src/background.js`:
- import に追加: `import { ensureLmStudio, listLmStudioModels } from './lib/lmstudio.js';`
- `keepAlive` の下に追加:
```js
const sendNativeMessage = (host, message) => chrome.runtime.sendNativeMessage(host, message);

/** LM Studio を使う設定なら、必要に応じて起動とモデル読み込みを済ませる */
function prepareProvider(settings, tabId) {
  if (settings.provider !== 'lmstudio') return Promise.resolve();
  const onProgress = (text) => {
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'phase', text }).catch(() => {});
  };
  return keepAlive(() => ensureLmStudio(settings.providers.lmstudio, { sendNativeMessage, onProgress }));
}
```
- `getConfig` を `async getConfig(_message, sender)` にし、`assertValid(s);` の直後に `await prepareProvider(s, sender?.tab?.id);` を追加
- `testConnection` の `assertValid(settings);` の直後に `await prepareProvider(settings, null);` を追加
- `handlers` に追加:
```js
  async listLmStudioModels() {
    return { models: await listLmStudioModels({ sendNativeMessage }) };
  },
```
- リスナー内の `handler(message).then(` を `handler(message, _sender).then(` に変更（引数名は `sender` にリネームしてよい）

- [ ] **Step 2: 構文と全テストを確認**

Run: `cd ~/ai-page-translator && ~/.local/node/bin/node --check src/background.js && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: エラーなし、PASS

- [ ] **Step 3: コミット**

```bash
git add src/background.js
git commit -m "feat: prepare LM Studio before translating and list its models" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 7: 設定画面の LM Studio 欄

**Files:**
- Modify: `src/options/options.html`, `src/options/options.js`

**Interfaces:**
- Consumes: `listLmStudioModels` メッセージ（Task 6）、設定項目 `providers.lmstudio.{model, baseUrl, autoStart}`（Task 1）

`chrome.*` に依存するため単体テストはしない（Task 8 で確認）。

- [ ] **Step 1: HTML を追加する**

`src/options/options.html` の `<fieldset data-provider="compat">…</fieldset>` の直後に追加:
```html
      <fieldset data-provider="lmstudio">
        <legend>LM Studio（ローカル）</legend>
        <label>モデル <input name="providers.lmstudio.model" list="lmstudio-models" placeholder="例: qwen/qwen2.5-coder-14b" autocomplete="off"></label>
        <datalist id="lmstudio-models"></datalist>
        <p class="hint" id="lmstudio-hint"></p>
        <button type="button" id="lmstudio-refresh">モデル一覧を更新</button>
        <label class="check"><input name="providers.lmstudio.autoStart" type="checkbox"> LM Studio を自動で起動する</label>
        <label>アドレス <input name="providers.lmstudio.baseUrl" placeholder="http://localhost:1234/v1"></label>
        <details>
          <summary>自動起動の準備（初回のみ）</summary>
          <ol class="hint">
            <li>ターミナルで <code>sh &lt;この拡張機能のフォルダ&gt;/native-host/install.sh</code> を実行する</li>
            <li><code>chrome://extensions</code> でこの拡張機能を再読み込みする</li>
          </ol>
          <p class="hint">Python 3.8 以上と LM Studio が必要です。削除するときは <code>native-host/uninstall.sh</code> を実行します。</p>
        </details>
      </fieldset>
```

- [ ] **Step 2: スクリプトを追加する**

`src/options/options.js`:
- `requestHostPermission` の先頭を次に置き換える:
```js
  if (settings.provider !== 'compat' && settings.provider !== 'lmstudio') return Promise.resolve(true);
  const origin = new URL(settings.providers[settings.provider].baseUrl).origin;
```
- `show` 関数の下に追加:
```js
async function loadLmStudioModels() {
  const hint = document.getElementById('lmstudio-hint');
  const list = document.getElementById('lmstudio-models');
  const input = form.querySelector('[name="providers.lmstudio.model"]');
  hint.textContent = 'モデル一覧を取得しています…';
  const res = await chrome.runtime
    .sendMessage({ type: 'listLmStudioModels' })
    .catch((err) => ({ ok: false, error: { message: String(err?.message ?? err) } }));
  if (!res?.ok) {
    hint.textContent = `モデル一覧を取得できませんでした: ${res?.error?.message ?? '不明なエラー'}。モデル名を直接入力することもできます。`;
    return;
  }
  list.replaceChildren(...res.models.map((m) => new Option(m.name, m.key)));
  hint.textContent = res.models.length
    ? `${res.models.length}個のモデルが見つかりました。入力欄から選べます。`
    : 'ダウンロード済みのモデルがありません。LM Studio でモデルをダウンロードしてください。';
  if (!input.value && res.models[0]) input.value = res.models[0].key;
}
```
- `providerSelect.addEventListener('change', showProviderSection);` を次に置き換える:
```js
providerSelect.addEventListener('change', () => {
  showProviderSection();
  if (providerSelect.value === 'lmstudio') loadLmStudioModels();
});
document.getElementById('lmstudio-refresh').addEventListener('click', loadLmStudioModels);
```
- 最終行 `fill(await loadSettings(chrome.storage.local));` の直後に追加:
```js
if (providerSelect.value === 'lmstudio') loadLmStudioModels();
```

- [ ] **Step 3: 構文と全テストを確認**

Run: `cd ~/ai-page-translator && ~/.local/node/bin/node --check src/options/options.js && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: エラーなし、PASS

- [ ] **Step 4: コミット**

```bash
git add src/options/options.html src/options/options.js
git commit -m "feat: add LM Studio section to the options page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```

---

### Task 8: 実機確認とドキュメント

**Files:**
- Modify: `README.md`, `docs/manual-test.md`

**Interfaces:**
- Consumes: Task 1〜7 のすべて

- [ ] **Step 1: README と手動確認手順を更新する**

`README.md` の「対応プロバイダ」の表に行を追加:
```markdown
| LM Studio（ローカル） | ダウンロード済みのモデルから選択 | LM Studio。自動起動には補助プログラム（下記） |
```
`README.md` の「使い方」の後に節を追加:
```markdown
## LM Studio の自動起動
「LM Studio（ローカル）」を選ぶと、翻訳時に LM Studio のサーバーが止まっていれば自動で起動し、選んだモデルを読み込みます（macOS / Linux）。

1. Python 3.8 以上と LM Studio をインストールしておく
2. ターミナルで `sh native-host/install.sh` を1回実行する
3. `chrome://extensions` で拡張機能を再読み込みする

補助プログラムが受け付けるのは「状態確認」「モデル一覧」「起動と読み込み」の3つの命令だけで、LM Studio の `lms` コマンド以外は実行しません。削除は `sh native-host/uninstall.sh`。

この版から拡張機能 ID を固定したため、以前の版の設定は引き継がれません。更新後に設定し直してください。
```
`docs/manual-test.md` の「## エラー」の前に節を追加:
```markdown
## LM Studio の自動起動
- [ ] `sh native-host/install.sh` が「インストールしました（拡張機能 ID: …）」と表示する
- [ ] 設定画面で「LM Studio（ローカル）」を選ぶと、モデル一覧（例: qwen/qwen2.5-coder-14b）が入力欄の候補に出る
- [ ] `lms server stop` でサーバーを止めた状態で「翻訳」→ 右下が「LM Studio を起動しています…」→ 翻訳される
- [ ] `lms unload --all` でモデルを外した状態で「翻訳」→「モデルを読み込んでいます…」→ 翻訳される
- [ ] `sh native-host/uninstall.sh` の後、サーバー停止中に「翻訳」→ 補助プログラムのインストールを促すエラー
- [ ] 存在しないモデル名で保存して「翻訳」→「モデル … が LM Studio にありません」
```

- [ ] **Step 2: 検証用 Chrome で実機確認する**

前回までの検証用スクリプト（`scratchpad/e2e/e2e.mjs`）を基に、次を自動で確かめる。補助プログラムは検証用 Chrome のプロファイル内にだけ登録する（`CHROME_NMH_DIR=<一時プロファイル>/NativeMessagingHosts`）。普段の Chrome の登録フォルダには書き込まない。
1. `Extensions.loadUnpacked` が返す拡張機能 ID が `python3 native-host/extension_id.py manifest.json` と一致する
2. 設定画面で `lmstudio` を選び、`listLmStudioModels` が `qwen/qwen2.5-coder-14b` を返す
3. `~/.lmstudio/bin/lms server stop` の後、テスト用ページで翻訳 → 状態が `done` になり、`lms server status --json` が `running: true` になる
4. 補助プログラムの登録ファイルを消した状態で、サーバー停止中に翻訳 → `error`（補助プログラムのインストールを促すメッセージ）

この手順は LM Studio のサーバーを止めたり起動したりする（ユーザーの LM Studio の状態を変える）。終了後はサーバーを起動したままにする。

- [ ] **Step 3: 全テストを確認**

Run: `cd ~/ai-page-translator && PATH=~/.local/node/bin:$PATH npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && PATH=~/.local/node/bin:$PATH npm run test:host 2>&1 | tail -2`
Expected: JS は fail 0、Python は `OK`

- [ ] **Step 4: コミット**

```bash
git add README.md docs/manual-test.md
git commit -m "docs: document LM Studio auto-start" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WokTU561EduwmgFKYNcZbp"
```
