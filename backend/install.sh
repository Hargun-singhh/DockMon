#!/bin/bash

echo "Installing DockMon Agent..."

INSTALL_DIR="$HOME/.dockmon"

mkdir -p $INSTALL_DIR

echo "Downloading agent..."

git clone https://github.com/Hargun-singhh/dockmon-agent.git $INSTALL_DIR

cd $INSTALL_DIR

echo "Installing dependencies..."

npm install

chmod +x agent.js

sudo ln -sf $INSTALL_DIR/agent.js /usr/local/bin/dockmon-agent

echo ""
echo "DockMon Agent installed successfully!"
echo ""
echo "Run:"
echo ""
echo "dockmon-agent"