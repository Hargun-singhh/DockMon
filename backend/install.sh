#!/bin/bash

set -e

echo "🚀 Installing DockMon Agent..."

INSTALL_DIR="$HOME/.dockmon"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.dockmon"

# -----------------------------
# CHECK NODE
# -----------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed. Please install Node.js first."
  exit 1
fi

# -----------------------------
# CREATE DIRS
# -----------------------------
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$CONFIG_DIR"

# -----------------------------
# DOWNLOAD AGENT
# -----------------------------
echo "📥 Downloading agent..."
curl -fsSL https://dockmon.onrender.com/agent.js -o "$INSTALL_DIR/agent.js"

cd "$INSTALL_DIR"

# -----------------------------
# INSTALL DEPENDENCIES
# -----------------------------
echo "📦 Installing dependencies..."

if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1
fi

npm install ws dockerode dotenv >/dev/null 2>&1

chmod +x "$INSTALL_DIR/agent.js"

# -----------------------------
# CREATE CLI (FIXED)
# -----------------------------
echo "⚙️ Creating CLI..."

cat <<'EOF' > "$BIN_DIR/dockmon-agent"
#!/bin/bash

CONFIG="$HOME/.dockmon/config.json"

if [ "$1" = "login" ]; then
  read -p "Enter DEVICE_TOKEN: " token
  mkdir -p "$HOME/.dockmon"
  echo "{ \"deviceToken\": \"$token\" }" > "$CONFIG"
  echo "✅ Token saved"

  echo "🔄 Restarting agent..."
  pm2 restart dockmon-agent >/dev/null 2>&1 || true

  exit 0
fi

node "$HOME/.dockmon/agent.js"
EOF

chmod +x "$BIN_DIR/dockmon-agent"

# -----------------------------
# PATH SETUP
# -----------------------------
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "⚠️ Adding $BIN_DIR to PATH..."

  SHELL_NAME=$(basename "$SHELL")

  if [ "$SHELL_NAME" = "zsh" ]; then
    echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.zshrc"
    export PATH="$PATH:$BIN_DIR"
  else
    echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$HOME/.bashrc"
    export PATH="$PATH:$BIN_DIR"
  fi
fi

# -----------------------------
# INSTALL PM2
# -----------------------------
echo "📦 Installing PM2..."

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 >/dev/null 2>&1
fi

# -----------------------------
# START AGENT
# -----------------------------
echo "🚀 Starting agent..."

pm2 delete dockmon-agent >/dev/null 2>&1 || true
pm2 start "$INSTALL_DIR/agent.js" --name dockmon-agent

pm2 save >/dev/null 2>&1

# -----------------------------
# PM2 STARTUP
# -----------------------------
echo "🔁 Enabling auto-start..."

PM2_CMD=$(pm2 startup | grep "sudo" || true)

if [ ! -z "$PM2_CMD" ]; then
  echo "👉 Run this command manually:"
  echo "$PM2_CMD"
fi

# -----------------------------
# DONE
# -----------------------------
echo ""
echo "✅ DockMon Agent installed successfully!"
echo ""
echo "👉 First time setup:"
echo "dockmon-agent login"
echo ""
echo "👉 Logs:"
echo "pm2 logs dockmon-agent"
echo ""
echo "👉 Restart:"
echo "pm2 restart dockmon-agent"
