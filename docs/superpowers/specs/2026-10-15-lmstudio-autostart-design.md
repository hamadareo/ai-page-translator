# LM Studio 自動起動 — 設計仕様書

- 作成日: 2026-10-15
- ステータス: レビュー待ち
- 前提: `docs/superpowers/specs/2026-10-13-ai-page-translator-design.md` の拡張機能に追加する機能

## 1. 目的と成功基準

### 目的
ローカルLLMとして LM Studio を使うとき、LM Studio のアプリやサーバーを閉じていても、ポップアップの「翻訳」を押すだけでサーバーの起動と指定モデルの読み込みを自動で行い、そのまま翻訳する。将来この拡張機能を他人に共有することを前提に、共有相手も同じ手順で導入できるようにする。

### 成功基準
1. LM Studio のサーバーが停止しているとき、「翻訳」を押すと自動でサーバーが起動し、設定したモデルが読み込まれ、翻訳が完了する。
2. サーバーが既に起動していてモデルも読み込み済みなら、補助プログラムを呼ばずにそのまま翻訳する。
3. 設定画面で、ダウンロード済みの LLM を一覧から選べる（LM Studio が閉じていても）。
4. 補助プログラム未導入・`lms` 不在・モデル不在・時間切れ・読み込み失敗のそれぞれで、原因と対処が分かる日本語のメッセージを表示し、ページを変更しない。
5. 補助プログラムは決められた3命令以外を実行しない。

### 前提（ユーザー確認済み）
- ユーザーは LM Studio のアプリ自体を閉じていることが多く、起動から自動化したい。
- 対象 OS は macOS と Linux（Windows は今回対象外）。

## 2. スコープ外
Windows 用の補助プログラム、翻訳後のモデル自動解放（LM Studio 標準の TTL 設定に任せる）、LM Studio 以外のローカルLLM（Ollama 等）の自動起動、モデルのダウンロード。

## 3. 全体構成

```
popup「翻訳」→ content script → background
  background: translateBatch の前に、プロバイダが lmstudio かつ自動起動オンなら ensureLmStudio を1回実行
     ├ GET {baseUrl}/models が 2 秒以内に成功 → 補助プログラムに ensure（モデル読み込みの確認のみ）
     └ 失敗 → 補助プログラムに ensure（サーバー起動＋モデル読み込み）→ GET {baseUrl}/models が成功するまで待つ（最大 90 秒）
  補助プログラム（Native Messaging host, Python 3）: lms server start / lms ps --json / lms load <model> -y
```

- 起動確認は「翻訳」1回（= content script の `getConfig` 1回）につき1回。バッチごとには行わない。
- 待機中は状態表示に「LM Studio を起動しています…」（サーバー起動待ち）または「モデルを読み込んでいます…」（読み込み待ち）を出す。background は `ensureLmStudio` の `onProgress` で、`getConfig` を送ってきたタブに `chrome.tabs.sendMessage(tabId, { type: 'phase', text })` を送る。

### 3.1 拡張機能側の変更
| ファイル | 変更 |
|---|---|
| `src/lib/settings.js` | プロバイダ `lmstudio` を追加（ラベル「LM Studio（ローカル）」）。既定値 `{ model: '', baseUrl: 'http://localhost:1234/v1', autoStart: true }`。検証: モデル名必須、baseUrl は http(s) |
| `src/lib/providers/lmstudio.js`（新規） | OpenAI 互換のリクエスト組み立て・応答解析を再利用（APIキーなし、JSON モードなし） |
| `src/lib/providers/index.js` | `lmstudio` を登録 |
| `src/lib/lmstudio.js`（新規） | `ensureLmStudio(config, { fetch, sendNativeMessage, sleep, now, onProgress })` と `listLmStudioModels({ sendNativeMessage })`。`chrome.*` に依存しない（注入） |
| `src/background.js` | `getConfig` 処理で、プロバイダが `lmstudio` かつ `autoStart` のとき `ensureLmStudio` を実行（失敗時は `getConfig` がそのエラーを返す）。新メッセージ `listLmStudioModels` |
| `src/lib/page-translator.js` | `setPhase(text)` を公開。状態に `phase`（文字列、既定 `null`）を持ち、変更時に `onStatus` を呼ぶ。`getConfig` 完了時に `phase` を `null` に戻す |
| `src/lib/status-overlay.js` | `statusText`: `translating` かつ `phase` があれば `phase` を表示（例: 「LM Studio を起動しています…」） |
| `src/content.js` | background からの `{ type: 'phase', text }` を受けて `setPhase(text)` を呼ぶ |
| `src/options/*` | LM Studio 欄: モデル選択（`listLmStudioModels` の結果、取得失敗時は手入力欄）、「LM Studio を自動で起動する」チェック、アドレス、補助プログラムの導入手順 |
| `manifest.json` | `permissions` に `nativeMessaging` を追加。`key` を追加して拡張機能 ID を固定 |

### 3.2 補助プログラム（`native-host/`）
| ファイル | 内容 |
|---|---|
| `lmstudio_host.py` | Native Messaging host 本体。Python 3 標準ライブラリのみ |
| `install.sh` | Python 3 の存在確認 → host 登録ファイル `com.aipagetranslator.lmstudio.json` を Chrome の NativeMessagingHosts フォルダに書く（macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`、Linux: `~/.config/google-chrome/NativeMessagingHosts/`）。`allowed_origins` は `chrome-extension://<固定ID>/` |
| `uninstall.sh` | 登録ファイルを削除 |
| `test_lmstudio_host.py` | `unittest` による単体テスト（偽の `lms` を使用） |

## 4. 補助プログラムの仕様

### 4.1 通信形式
Chrome Native Messaging の標準形式: 標準入力から「4バイト（ネイティブエンディアンの uint32）の長さ＋UTF-8 JSON」を1件読み、同じ形式で1件返して終了する。

### 4.2 命令
| 命令（`{"cmd": ...}`） | 処理 | 応答 |
|---|---|---|
| `status` | `lms server status --json` | `{"ok": true, "lms": true, "running": bool, "port": number}` |
| `list` | `lms ls --json` から `type == "llm"` を抽出 | `{"ok": true, "models": [{"key", "name"}]}` |
| `ensure`（`model`, `port`） | `model` が `lms ls` の `modelKey` に存在するか確認 → サーバー停止中なら `lms server start --port <port>` → `lms ps --json` に `model` がなければ `lms load <model> -y` | `{"ok": true, "started": bool, "loaded": bool}` |

- 上記以外の `cmd` は `{"ok": false, "error": {"kind": "bad_command"}}`。
- `port` は 1〜65535 の整数のみ受け付ける。
- コマンドは `subprocess.run([...], shell=False, timeout=...)` で実行（シェル不使用）。
- 時間制限: `server start` 60 秒、`load` 120 秒、その他 15 秒。超過時は `{"ok": false, "error": {"kind": "timeout", "step": "start"|"load"}}`。
- エラー応答の `kind`: `lms_not_found`、`model_not_found`、`timeout`、`load_failed`（`message` に `lms` の標準エラー出力の先頭 300 文字）、`bad_command`、`bad_request`。

### 4.3 `lms` の探索
`~/.lmstudio/bin/lms` が実行可能ならそれを、なければ `PATH` 上の `lms` を使う。どちらもなければ `lms_not_found`。

## 5. `ensureLmStudio` の仕様（拡張機能側）

1. `GET {baseUrl}/models`（2 秒で打ち切り）。成功したらサーバー稼働中。
2. 補助プログラムに `ensure`（`model`, `port` = baseUrl のポート、既定 1234）を送る。
   - `chrome.runtime.sendNativeMessage` が「host が見つからない」で失敗 → サーバー稼働中なら JIT 読み込みに任せて続行、停止中なら `helper_missing` エラー。
3. サーバーが停止していた場合は、`GET {baseUrl}/models` が成功するまで 1 秒間隔で待つ（最大 90 秒）。超過したら `timeout` エラー。
4. 補助プログラムのエラーは `TranslationError` に変換（すべて致命的 = 翻訳を止める）:

| 補助プログラムの `kind` | 拡張機能の `kind` | メッセージ |
|---|---|---|
| （host 未登録） | `config` | LM Studio を自動起動するには補助プログラムのインストールが必要です（設定画面に手順があります）。または LM Studio を起動してサーバーをオンにしてください |
| `lms_not_found` | `config` | LM Studio が見つかりません。LM Studio をインストールし、一度起動してください |
| `model_not_found` | `config` | モデル ○○ が LM Studio にありません。設定画面でモデルを選び直してください |
| `timeout` | `network` | LM Studio の起動（またはモデルの読み込み）に時間がかかっています。LM Studio の画面を確認してください |
| `load_failed` | `config` | LM Studio でモデルを読み込めませんでした（詳細） |

5. `autoStart` がオフなら何もしない（従来どおり、接続できなければ翻訳時に `network` エラー）。

## 6. 拡張機能 ID の固定
- `manifest.json` に `key`（RSA 2048 の公開鍵、Base64 DER）を追加し、パッケージ化されていない読み込みでもどの環境でも同じ ID にする。
- 秘密鍵 `extension-key.pem` はリポジトリに含めない（`.gitignore`）。必要になるのは .crx を作る場合のみ。
- `install.sh` の `allowed_origins` にはこの固定 ID を書く。Chrome ウェブストア公開時はストアの ID に合わせて更新する。
- 注意: ID が変わるため、既存の設定（`chrome.storage.local`）は引き継がれない。更新後に設定し直す（README と手動確認に記載）。

## 7. テスト方針
TDD で進める。
- `test/lmstudio.test.js`（`node --test`）: `ensureLmStudio` を偽の fetch・偽の `sendNativeMessage`・偽の時計で検証。稼働中なら起動しない／停止中なら `ensure` → 応答まで待つ／各エラーの変換／`autoStart` オフ／host 未登録時の分岐。`listLmStudioModels` の整形。
- `test/settings.test.js`・`test/providers.test.js`: `lmstudio` の既定値・検証・リクエスト形状。
- `test/manifest.test.js`: `nativeMessaging` 権限と `key` の存在。
- `test/page-translator.test.js`・`test/status-overlay.test.js`: `setPhase` で状態に `phase` が入り、`getConfig` 後に消えること、`statusText` が `phase` を表示すること。
- `native-host/test_lmstudio_host.py`（`python3 -m unittest`）: 通信形式の読み書き、命令の制限、存在しないモデルの拒否、ポート検証、`shell=False` で引数リストが渡ること、時間切れ、`lms` 探索。偽の `lms` は一時ディレクトリに置いたスクリプト。
- 実機確認（`docs/manual-test.md` に追記）: このMacで LM Studio のサーバーを停止した状態から「翻訳」→ 自動起動・読み込み → 翻訳完了。補助プログラム未導入時の案内表示。
