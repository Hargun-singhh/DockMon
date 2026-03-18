#!/usr/bin/env node

require("dotenv").config();

const WebSocket = require("ws");
const Docker = require("dockerode");
const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
---------------------------------------
CONFIG
---------------------------------------
*/

const WS_URL = "wss://dockmon.onrender.com/agent";
const CONFIG_PATH = path.join(os.homedir(), ".dockmon", "config.json");

/*
---------------------------------------
DOCKER (Cross-platform)
---------------------------------------
*/

const docker =
  process.platform === "win32"
    ? new Docker({ socketPath: "//./pipe/docker_engine" })
    : new Docker({ socketPath: "/var/run/docker.sock" });

/*
---------------------------------------
STATE
---------------------------------------
*/

let ws;
let reconnectTimer;
let reconnectDelay = 1000;
const MAX_DELAY = 5000;
let shuttingDown = false;

/*
---------------------------------------
LOG
---------------------------------------
*/

const log = (msg, meta) => {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${new Date().toISOString()}] ${msg}${suffix}`);
};

/*
---------------------------------------
TOKEN LOAD
---------------------------------------
*/

const getToken = () => {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return data.deviceToken;
  } catch {
    return null;
  }
};

/*
---------------------------------------
UTILS
---------------------------------------
*/

const sendJson = (payload) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const formatContainer = (c) => ({
  id: c.Id,
  names: c.Names,
  image: c.Image,
  state: c.State,
  status: c.Status,
});

/*
---------------------------------------
DOCKER HANDLERS
---------------------------------------
*/

const handlers = {
  async list_containers() {
    const containers = await docker.listContainers({ all: true });
    return containers.map(formatContainer);
  },

  async start_container({ container_id }) {
    await docker.getContainer(container_id).start();
    return { success: true };
  },

  async stop_container({ container_id }) {
    await docker.getContainer(container_id).stop();
    return { success: true };
  },

  async restart_container({ container_id }) {
    await docker.getContainer(container_id).restart();
    return { success: true };
  },

  async remove_container({ container_id }) {
    await docker.getContainer(container_id).remove({ force: true });
    return { success: true };
  },
};

/*
---------------------------------------
COMMAND HANDLER
---------------------------------------
*/

const handleCommand = async (msg) => {
  const { request_id, command, payload } = msg;

  if (!handlers[command]) {
    throw new Error("Unsupported command");
  }

  const result = await handlers[command](payload || {});

  sendJson({
    type: "response",
    request_id,
    data: result,
  });
};

/*
---------------------------------------
RECONNECT LOGIC
---------------------------------------
*/

const scheduleReconnect = () => {
  if (shuttingDown || reconnectTimer) return;

  log("Reconnecting...", { delay: reconnectDelay });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
  }, reconnectDelay);
};

/*
---------------------------------------
CONNECT
---------------------------------------
*/

const connect = () => {
  const deviceToken = getToken();

  if (!deviceToken) {
    log("❌ No DEVICE_TOKEN found. Run: dockmon-agent login");
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    reconnectDelay = 1000;

    log("✅ Connected");

    sendJson({
      type: "register",
      device_token: deviceToken,
    });

    log("📡 Registered");
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "command") {
        await handleCommand(msg);
      }
    } catch (e) {
      console.error("Error:", e.message);
    }
  });

  ws.on("close", scheduleReconnect);

  ws.on("error", (err) => {
    console.error("WS Error:", err.message);
  });
};

/*
---------------------------------------
INTERNET DETECTION
---------------------------------------
*/

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  dns.lookup("google.com", (err) => {
    if (!err) {
      log("🌐 Internet back → reconnecting");

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      connect();
    }
  });
}, 2000);

/*
---------------------------------------
SHUTDOWN
---------------------------------------
*/

const shutdown = () => {
  shuttingDown = true;

  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();

  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/*
---------------------------------------
START
---------------------------------------
*/

connect();
