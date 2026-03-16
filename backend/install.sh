#!/bin/bash

echo "Installing DockMon Agent..."

INSTALL_DIR="/usr/local/bin"
AGENT_URL="https://raw.githubusercontent.com/Hargun-singhh/dockmon-agent/main/agent.js"

curl -L $AGENT_URL -o dockmon-agent

chmod +x dockmon-agent

sudo mv dockmon-agent $INSTALL_DIR/dockmon-agent

echo ""
echo "DockMon Agent installed successfully!"
echo ""
echo "Run:"
echo ""
echo "dockmon-agent"