# AI Page Translator

生成AIを使って Web ページ全体を翻訳する Chrome 拡張機能です。Google 翻訳の「ページ翻訳」のように、ページの文章を訳文に置き換えます。

## 対応プロバイダ
| プロバイダ | 既定モデル | 必要なもの |
|---|---|---|
| OpenAI | `gpt-5.5` | APIキー |
| Anthropic (Claude) | `claude-opus-5-5` | APIキー |
| Google Gemini | `gemini-3.8-flash` | APIキー |
| OpenAI互換 / ローカルLLM | `llama3.2`（Ollama） | ベースURL（APIキーは任意） |
| LM Studio（ローカル） | ダウンロード済みのモデルから選択 | LM Studio。自動起動には補助プログラム（下記） |

OpenAI互換には Ollama（`http://localhost:11434/v1`）、LM Studio（`http://localhost:1234/v1`）、OpenRouter などを指定できます。モデル名は設定画面で自由に変更できます。

## インストール
1. `chrome://extensions` を開き「デベロッパーモード」をオン
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
3. 拡張機能のオプションでプロバイダ・APIキー・モデルを設定し「接続テスト」

## 使い方
ツールバーのアイコン → 「翻訳」。「停止」で翻訳を止め、「原文に戻す」で元のページに戻します。翻訳中に追加された内容（無限スクロールなど）も自動で翻訳します。

設定で「クリックした先のページも自動で翻訳する」をオンにすると、「翻訳」を押したタブで別のページへ移ったとき（ほかのサイトや、リンクから開いた新しいタブを含む）も自動で翻訳を続けます。「停止」「原文に戻す」を押すか、タブを閉じると止まります。オンにするときに、すべてのサイトへのアクセスの許可を求めます。

## LM Studio の自動起動
「LM Studio（ローカル）」を選ぶと、翻訳時に LM Studio のサーバーが止まっていれば自動で起動し、選んだモデルを読み込みます（macOS / Linux）。

1. Python 3.8 以上と LM Studio をインストールしておく
2. ターミナルで `sh native-host/install.sh` を1回実行する
3. `chrome://extensions` で拡張機能を再読み込みする

補助プログラムが受け付けるのは「状態確認」「モデル一覧」「起動と読み込み」の3つの命令だけで、LM Studio の `lms` コマンド以外は実行しません。削除は `sh native-host/uninstall.sh`。

この版から拡張機能 ID を固定したため、以前の版の設定は引き継がれません。更新後に設定し直してください。

## プライバシー
APIキーと設定は `chrome.storage.local`（この端末のみ）に保存されます。ページの文章は、選んだプロバイダへの翻訳リクエストとしてのみ送信されます。「クリックした先のページも自動で翻訳する」をオンにしたタブでは、移った先のページの文章も送信されます。

## 開発
```sh
npm install
npm test
```
設計: `docs/superpowers/specs/2026-10-13-ai-page-translator-design.md` / 手動確認: `docs/manual-test.md`

## ライセンス
[MIT](LICENSE)
