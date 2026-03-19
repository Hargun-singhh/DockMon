#!/bin/bash
echo "🚀 Installing DockMon Agent..."

BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.dockmon"

mkdir -p "$BIN_DIR" "$CONFIG_DIR"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "❌ Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Windows via Git Bash / WSL
if [[ "$OS" == *"mingw"* ]] || [[ "$OS" == *"msys"* ]]; then
  OS="windows"
fi

BINARY="dockmon-agent-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then
  BINARY="${BINARY}.exe"
fi

echo "📥 Downloading agent for ${OS}/${ARCH}..."

DOWNLOAD_URL="https://github.com/yourusername/dockmon/releases/latest/download/${BINARY}"

curl -fsSL --max-time 30 "$DOWNLOAD_URL" -o "$BIN_DIR/dockmon-agent"

if [ $? -ne 0 ]; then
  echo "❌ Download failed. Check your internet connection."
  exit 1
fi

chmod +x "$BIN_DIR/dockmon-agent"
echo "✅ Agent downloaded"

# Create login CLI wrapper
cat <<'EOF' > "$BIN_DIR/dockmon-login"
#!/bin/bash
read -p "Enter DEVICE_TOKEN: " token
mkdir -p "$HOME/.dockmon"
echo "{ \"deviceToken\": \"$token\" }" > "$HOME/.dockmon/config.json"
echo "✅ Token saved"
echo "🔄 Restarting agent..."
pm2 restart dockmon-agent >/dev/null 2>&1 || true
EOF
chmod +x "$BIN_DIR/dockmon-login"

# PATH setup
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  SHELL_NAME=$(basename "$SHELL")
  if [ "$SHELL_NAME" = "zsh" ]; then
    echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.zshrc"
  else
    echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.bashrc"
  fi
  export PATH="$PATH:$BIN_DIR"
fi

# Install PM2 if missing
if ! command -v pm2 >/dev/null 2>&1; then
  echo "📦 Installing PM2..."
  npm install -g pm2 --loglevel=error
fi

# Start agent
echo "🚀 Starting agent..."
pm2 delete dockmon-agent >/dev/null 2>&1 || true
pm2 start "$BIN_DIR/dockmon-agent" --name dockmon-agent
pm2 save >/dev/null 2>&1

# PM2 startup
PM2_CMD=$(pm2 startup 2>/dev/null | grep "sudo" || true)
if [ ! -z "$PM2_CMD" ]; then
  echo "👉 Run this to survive reboots:"
  echo "$PM2_CMD"
fi

echo ""
echo "✅ DockMon Agent installed!"
echo ""
echo "👉 Login:   dockmon-login"
echo "👉 Logs:    pm2 logs dockmon-agent"
echo "👉 Restart: pm2 restart dockmon-agent"
