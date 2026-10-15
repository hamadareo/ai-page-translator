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
echo "インストールしました（拡張機能 ID: ${EXT_ID}）。Chrome で拡張機能を再読み込みしてください。"
