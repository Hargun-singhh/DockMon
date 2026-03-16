#!/bin/bash

echo "Installing DockMon Agent..."

INSTALL_DIR="$HOME/.dockmon"

mkdir -p $INSTALL_DIR

echo "Downloading agent..."

curl -fsSL https://dockmon.onrender.com/agent.js -o $INSTALL_DIR/agent.js

cd $INSTALL_DIR

echo "Installing dependencies..."

npm init -y >/dev/null 2>&1
npm install ws dockerode dotenv >/dev/null 2>&1

chmod +x $INSTALL_DIR/agent.js

echo "Creating dockmon-agent command..."

echo '#!/bin/bash' | sudo tee /usr/local/bin/dockmon-agent > /dev/null
echo "node $INSTALL_DIR/agent.js" | sudo tee -a /usr/local/bin/dockmon-agent > /dev/null
sudo chmod +x /usr/local/bin/dockmon-agent

echo ""
echo "DockMon Agent installed successfully!"
echo ""
echo "Run:"
echo ""
echo "dockmon-agent"
