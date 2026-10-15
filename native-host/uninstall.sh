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
