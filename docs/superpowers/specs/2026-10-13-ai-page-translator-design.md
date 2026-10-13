# AI Page Translator — 設計仕様書

- 作成日: 2026-10-13
- ステータス: レビュー待ち

## 1. 目的と成功基準

### 目的
英語などの外国語のWebページを、生成AI（クラウドAPI または ローカルLLM）を使って日本語に置き換えて読めるようにする Chrome 拡張機能。Google 翻訳の「ページ翻訳」の代替として使う。

### 成功基準
1. ツールバーアイコン → ポップアップの「翻訳」ボタンで、表示中のページ全体が翻訳先言語（既定: 日本語）に置き換わる。
2. リンク・太字などのインライン要素を含む段落でも、自然な語順の訳文になり、リンク先・クラス・イベントは保持される。
3. 「原文に戻す」で翻訳前の DOM に完全に戻る。「停止」で翻訳処理が止まる。
4. 翻訳中のページで後から追加されたコンテンツ（無限スクロール・SPA）も自動で翻訳される。
5. OpenAI / Anthropic / Gemini / OpenAI互換（Ollama・LM Studio・OpenRouter 等）のいずれでも動作する。
6. エラー（キー誤り・レート制限・ローカルサーバー未起動）がページ上で分かる形で表示される。

### 前提（ユーザー確認済み）
- 個人利用。Chrome の「パッケージ化されていない拡張機能を読み込む」で使う。ストア公開はしない。
- 表示方式は置換のみ（対訳表示はしない）。
- 起動はポップアップのボタンのみ。

## 2. スコープ外（YAGNI）
自動翻訳（サイト指定）、右クリックメニュー、キーボードショートカット、対訳表示、iframe 内・Shadow DOM 内の翻訳、`alt`/`placeholder` 等の属性翻訳、ストリーミング表示、ストア公開。

## 3. 技術方針
- Manifest V3、素の JavaScript（ES Modules）、ビルド工程なし。フォルダをそのまま読み込める。
- 型は JSDoc で補う。
- テストは `node --test` + `jsdom`（devDependency のみ）。

## 4. アーキテクチャ

```
popup ──(メッセージ)──▶ content script ──(翻訳依頼: 文字列配列)──▶ background (service worker) ──fetch──▶ 各プロバイダ
options ──(chrome.storage)──▶ background
```

| コンポーネント | 責務 |
|---|---|
| popup | 「翻訳」「原文に戻す」「停止」ボタン、進捗表示、現在のプロバイダ／モデル名表示 |
| content script | テキスト抽出、バッチ化、DOM 置換と原文保持、MutationObserver による追加分の監視、ページ右下の状態表示 |
| background | 翻訳依頼の受付、キャッシュ照会、並列数制御、リトライ、プロバイダ呼び出し。API キーを扱うのはここだけ |
| options | プロバイダ選択、API キー、モデル名、ベース URL、翻訳先言語、バッチ上限、並列数、接続テスト、キャッシュ消去 |

### 4.1 注入とメッセージング
- popup の「翻訳」押下時に `chrome.scripting.executeScript` で content script を現在のタブに注入する（`activeTab` 権限）。二重注入は content script 側のグローバルフラグで防ぐ。
- popup → content: `{type: "translate" | "restore" | "stop" | "status"}`。
- content → background: `{type: "translateBatch", texts: string[]}` → 応答 `{ok: true, translations: string[]} | {ok: false, error: {kind, message}}`。
- content → popup（popup が開いていれば）: 進捗 `{type: "progress", done, total, failed, state}`。popup を開いた時は `status` で現在状態を取得する。

## 5. テキスト抽出と置換（content script / `lib/extract.js`, `lib/rebuild.js`）

### 5.1 翻訳単位
- 翻訳単位は「ブロック」。ブロック要素（`p`, `h1-6`, `li`, `td`, `th`, `dt`, `dd`, `blockquote`, `figcaption`, `caption`, `div` 等）のうち、直接の子にテキストまたはインライン要素を持つものの「連続したインライン内容の並び（ラン）」を1単位とする。ブロック子要素を挟む場合、その前後のランは別単位になる。
- インライン要素の定義: `a, abbr, b, bdi, bdo, br, cite, code, data, dfn, em, i, img, kbd, label, mark, q, s, samp, small, span, strong, sub, sup, time, u, var, wbr, font`。
- 除外: `script, style, noscript, template, pre, textarea, input, select, option, svg, math, canvas, iframe` の内部、`[contenteditable]`、`[translate="no"]`、`.notranslate`、拡張機能自身の状態表示要素。
- `code` / `kbd` / `samp` は段落内のインライン要素として目印タグ化し、プロンプトでその中身を訳さないよう指示する（6.2）。段落外で単独に置かれた `code`（ブロック相当）は翻訳単位にしない。
- 文字（Unicode の Letter カテゴリ `\p{L}`）を含まない単位は除外。
- `document.title` も1単位として扱う。

### 5.2 目印付き文字列への変換
- テキストはそのまま（`<`, `>`, `&` はエスケープ）。
- 子を持ちうるインライン要素は `<gN>…</gN>`、`br`/`img`/`wbr` は `<xN/>`。N は単位内の連番。入れ子可。
- 例: `Click <a href="/x">here</a> to <b>continue</b>` → `Click <g0>here</g0> to <g1>continue</g1>`

### 5.3 訳文の反映
- 訳文を簡易パーサで解析し、目印の集合（N と種類）が元と一致し、入れ子が正しいことを検証する。
- 一致した場合: 元の要素オブジェクトを再利用し（子テキストのみ入れ替え）、訳文の順序で並べ直す。属性・イベントリスナーは保持される。
- 不一致の場合: その単位を構成するテキストノードを個別の単位として再翻訳し、各テキストノードの値を置き換える（フォールバック）。
- 置換前の子ノード配列を `WeakMap<Element, Node[]>` に保存（ランの場合は親要素とランの範囲を保持）。`document.title` は元の文字列を保持。
- 拡張機能が書いたテキストノードとその内容を `WeakMap<Text, string>` で記録する（ページの DOM に属性は追加しない）。

### 5.4 原文に戻す
保存した子ノード配列で置き換え、記録を消去し、タイトルを復元する。jsdom テストで、翻訳→復元後の `innerHTML` が元と一致することを確認する。

### 5.5 翻訳順序とバッチ
- 画面内（`getBoundingClientRect` がビューポートと交差）の単位を先に、残りを文書順に。
- バッチ上限: 既定 40 単位 または 3,000 文字（どちらか先に達した方）。設定で変更可。1単位が上限文字数を超える場合は単独バッチ。

### 5.6 動的コンテンツ
- 翻訳中状態（「原文に戻す」を押すまで）は `MutationObserver`（`childList`, `subtree`, `characterData`）で監視。
- 変更は 500ms のデバウンスでまとめ、未翻訳の単位のみ抽出して翻訳する。
- 自身の DOM 書き換え中は observer を `disconnect` し、終了後に再接続する。記録したテキストノードの内容が自身の書いた訳文と異なる（ページ側が書き換えた）場合は再翻訳対象にする。送信済みの原文も別の `WeakMap` で記録して二重送信を防ぎ、「翻訳」を押し直したときはこの記録をリセットして失敗分を再試行する。

### 5.7 状態表示
ページ右下に Shadow DOM で隔離した小さな表示を出す。「翻訳中 12/40」「完了」「n件失敗」「エラー: APIキーを確認してください」等。完了後数秒で自動的に薄く小さくなり、エラー時は閉じるまで残る。

## 6. プロバイダ連携（background / `lib/providers/`, `lib/prompt.js`）

### 6.1 共通インターフェース
```js
/** @returns {Promise<string[]>} */
translate(texts, targetLang, config, { fetch, signal })
```
`fetch` は注入可能（テスト用）。各プロバイダは「リクエスト組み立て」と「応答からテキスト取り出し」の純粋関数を分けて持つ。

### 6.2 プロンプトと応答解析（全プロバイダ共通）
- システムプロンプト（要旨）: 「プロの翻訳者として、各要素を{targetLang}に自然に翻訳する。`<g0>`…`</g0>`、`<x0/>` 等の目印タグは位置を適切に調整しつつ全て保持する。`<code>` 相当の中身や URL・コードは訳さない。要素数と順序を変えない。説明文を付けず、`{"translations": [...]}` の JSON のみ返す。」
- ユーザーメッセージ: `{"texts": [...]}`（JSON）。
- 解析: コードフェンスを除去 → 最初の `{` から最後の `}` を JSON として解析 → `translations` が文字列配列であることを確認。
- 件数不一致・解析失敗: バッチを半分に分割して再依頼、最終的に1件ずつ。1件でも失敗したらその単位は原文のまま「失敗」として数える。

### 6.3 各プロバイダの差分

| 形式 | URL | 認証 | JSON 指定 |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer <key>` | `response_format: {type: "json_object"}` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true` | プロンプトで指示 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key` | `generationConfig.responseMimeType: "application/json"` |
| OpenAI互換 | `{baseUrl}/chat/completions` | キー任意（あれば Bearer） | 既定では送らない（設定で ON 可） |

- `openai-compatible.js` は `openai.js` のリクエスト組み立て／解析を再利用し、URL・認証・JSON 指定の有無だけ変える。
- モデル名は自由入力。既定値は OpenAI `gpt-5.5`、Anthropic `claude-opus-5-5`、Gemini `gemini-3.8-flash`、OpenAI互換 `llama3.2`（2026-10 時点で確認）。OpenAI互換の既定はベース URL `http://localhost:11434/v1`（Ollama）。
- `max_tokens` 等の出力上限は、入力文字数から十分な値を算出して設定する（Anthropic は必須）。

### 6.4 権限
- `permissions`: `activeTab`, `scripting`, `storage`。
- `host_permissions`: 上記3社の API ホスト、`http://localhost/*`, `http://127.0.0.1/*`。
- `optional_host_permissions`: `<all_urls>`。OpenAI互換で上記以外のベース URL を保存する際に `chrome.permissions.request` でそのオリジンのみ要求する。

## 7. キャッシュ（`lib/cache.js`）
- キー: `provider|model|targetLang|原文` の SHA-256（`crypto.subtle`）。
- 保存先: `chrome.storage.local`。上限 5,000 件、超過時は最終利用が古いものから削除。
- background でバッチ内のキャッシュ済み単位を除いた分だけ API に送り、結果を元の順序に戻して返す。
- options に「キャッシュを消去」ボタン。

## 8. 並列制御・リトライ・停止
- background でプロバイダ呼び出しの同時実行数を制限（既定 3、設定可）。
- 429 / 5xx / ネットワーク一時エラー: 指数バックオフ（1s, 2s, 4s）で最大3回。`Retry-After` があれば優先。
- 停止: content script がキュー投入を止め、以後届いた結果は破棄する。

## 9. エラー処理

| 種類 (`kind`) | 条件 | 挙動 |
|---|---|---|
| `auth` | 401 / 403（クラウド） | 全体停止、「APIキーを確認してください」 |
| `rate_limit` | 429 がリトライ後も続く | 該当バッチ失敗扱い、継続 |
| `network` | 接続失敗 | ローカル URL なら「サーバーが起動しているか確認してください」。全体停止 |
| `forbidden_local` | localhost で 403 | 「Ollama の場合は環境変数 `OLLAMA_ORIGINS` に `chrome-extension://*` を設定」と案内。全体停止 |
| `bad_response` | 解析失敗・件数不一致が分割後も続く | 該当単位を原文のまま失敗扱い、継続 |
| `config` | キー未設定・モデル未設定 | 翻訳開始前に表示し、設定画面へのリンク |

部分失敗は最後に「n件失敗」と表示する。

## 10. 設定（`lib/settings.js`）
| 項目 | 既定値 |
|---|---|
| provider | `openai` |
| 各プロバイダの apiKey / model / baseUrl | プロバイダごとに別保存 |
| targetLang | `日本語` |
| maxUnitsPerBatch / maxCharsPerBatch | 40 / 3000 |
| concurrency | 3 |
| providers.compat.jsonMode | false |

保存先は `chrome.storage.local`（API キーは端末外へは各プロバイダへのリクエスト以外で送信しない）。

## 11. ファイル構成
```
ai-page-translator/
├── manifest.json
├── src/
│   ├── background.js
│   ├── content.js
│   ├── popup/   popup.html, popup.js, popup.css
│   ├── options/ options.html, options.js, options.css
│   └── lib/
│       ├── extract.js
│       ├── rebuild.js
│       ├── batch.js
│       ├── prompt.js
│       ├── cache.js
│       ├── settings.js
│       └── providers/ index.js, openai.js, anthropic.js, gemini.js, openai-compatible.js
├── test/
├── docs/
└── package.json   # devDependencies: jsdom のみ
```
content script は ES Modules を直接使えないため、`content.js` から `chrome.runtime.getURL` + 動的 `import()` で `lib/` を読み込む（`web_accessible_resources` に `src/lib/*` を登録）。

## 12. テスト方針
TDD で進める。単体テスト（`node --test` + jsdom）:
- `extract` / `rebuild`: 目印変換と復元、除外要素、ブロック境界でのラン分割、タグ不一致時のフォールバック、翻訳→復元で `innerHTML` 完全一致。
- `batch`: 件数・文字数上限での分割、上限超過の単一単位。
- `prompt`: コードフェンス付き・前後に余計な文がある応答の解析、件数不一致検出。
- `providers`: fetch モックで URL・ヘッダー・ボディを検証、各社レスポンスからの取り出し、HTTP ステータスからのエラー分類。
- `cache`: キーの一意性、上限超過時の削除。

手動確認（チェックリストを `docs/manual-test.md` に用意）: 拡張機能を読み込み、英語版 Wikipedia 記事・ニュースサイト・無限スクロールのページで、翻訳／原文に戻す／停止／追加分の翻訳／誤ったキーでのエラー表示を各プロバイダ（少なくとも1つのクラウドと Ollama）で確認する。
