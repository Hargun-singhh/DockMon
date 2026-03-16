#!/bin/bash

echo "Installing DockMon Agent..."

INSTALL_DIR="$HOME/.dockmon"

mkdir -p $INSTALL_DIR

echo "Downloading agent..."

curl -fsSL https://dockmon.onrender.com/agent.js -o $INSTALL_DIR/agent.js

chmod +x $INSTALL_DIR/agent.js

sudo ln -sf $INSTALL_DIR/agent.js /usr/local/bin/dockmon-agent

echo ""
echo "DockMon Agent installed successfully!"
echo ""
echo "Run:"
echo ""
echo "dockmon-agent"