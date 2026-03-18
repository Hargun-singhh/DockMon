#!/bin/bash

set -e

echo "🚀 Installing DockMon Agent..."

INSTALL_DIR="$HOME/.dockmon"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.dockmon"

mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$CONFIG_DIR"

echo "📥 Downloading agent..."
curl -fsSL https://dockmon.onrender.com/agent.js -o "$INSTALL_DIR/agent.js"

cd "$INSTALL_DIR"

echo "📦 Installing dependencies..."
if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1
fi

npm install ws dockerode dotenv >/dev/null 2>&1

chmod +x "$INSTALL_DIR/agent.js"

echo "⚙️ Creating CLI..."

cat <<EOF > "$BIN_DIR/dockmon-agent"
#!/bin/bash

CONFIG="$HOME/.dockmon/config.json"

if [ "\$1" = "login" ]; then
  read -p "Enter DEVICE_TOKEN: " token
  mkdir -p "$HOME/.dockmon"
  echo "{ \"deviceToken\": \"\$token\" }" > "\$CONFIG"
  echo "✅ Token saved"
  exit 0
fi

node "$INSTALL_DIR/agent.js"
EOF

chmod +x "$BIN_DIR/dockmon-agent"

# PATH setup
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  SHELL_NAME=$(basename "$SHELL")

  if [ "$SHELL_NAME" = "zsh" ]; then
    echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.zshrc"
    echo "👉 Run: source ~/.zshrc"
  else
    echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.bashrc"
    echo "👉 Run: source ~/.bashrc"
  fi
fi

echo "📦 Installing PM2..."
npm install -g pm2 >/dev/null 2>&1 || true

echo "🚀 Starting agent..."

pm2 start "$INSTALL_DIR/agent.js" --name dockmon-agent >/dev/null 2>&1 || true
pm2 save >/dev/null 2>&1 || true
pm2 startup >/dev/null 2>&1 || true

echo ""
echo "✅ Installed successfully!"
echo ""
echo "👉 Run login:"
echo "dockmon-agent login"
echo ""
echo "👉 Logs:"
echo "pm2 logs dockmon-agent"
