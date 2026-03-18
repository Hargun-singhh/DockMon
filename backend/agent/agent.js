#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const WebSocket = require("ws");
const Docker = require("dockerode");
const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WS_URL = "wss://dockmon.onrender.com/agent";

const docker =
  process.platform === "win32"
    ? new Docker({ socketPath: "//./pipe/docker_engine" })
    : new Docker({ socketPath: "/var/run/docker.sock" });

const CONFIG_PATH = path.join(os.homedir(), ".dockmon", "config.json");

const getToken = () => {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data.deviceToken || null;
  } catch (err) {
    console.error("⚠️ Failed to read config:", err.message);
    return null;
  }
};

const deviceToken = getToken();

if (!deviceToken) {
  console.error("❌ No DEVICE_TOKEN found.");
  console.error("👉 Run: dockmon-agent login");
  process.exit(1);
}

/*
---------------------------------------
STATE
---------------------------------------
*/

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_DELAY = 5000;
let shuttingDown = false;
let isConnecting = false;
let lastConnectedAt = 0;
const CONNECT_COOLDOWN = 4000;

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

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const isConnected = () => ws && ws.readyState === WebSocket.OPEN;

/*
---------------------------------------
HELPERS
---------------------------------------
*/

const getStats = (container) =>
  new Promise((resolve, reject) => {
    container.stats({ stream: false }, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });

/*
---------------------------------------
HANDLERS
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
  async logs({ container_id }) {
    const container = docker.getContainer(container_id);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: 500,
    });
    if (!buffer) return "No logs";
    return buffer.toString("utf8") || "No logs";
  },
  async stats({ container_id }) {
    const stats = await getStats(docker.getContainer(container_id));
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage -
      stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount =
      stats.cpu_stats.online_cpus ||
      stats.cpu_stats.cpu_usage.percpu_usage.length;
    const cpu =
      systemDelta > 0 && cpuDelta > 0
        ? (cpuDelta / systemDelta) * cpuCount * 100
        : 0;
    return {
      cpu_percent: Number(cpu.toFixed(2)),
      memory_usage: stats.memory_stats.usage,
      memory_limit: stats.memory_stats.limit,
    };
  },
  async list_images() {
    return await docker.listImages();
  },
  async pull_image({ image }) {
    return new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => {
          if (err) reject(err);
          else resolve({ success: true, image });
        });
      });
    });
  },
  async run_container({ image, name }) {
    const container = await docker.createContainer({ Image: image, name });
    await container.start();
    return { success: true, container_id: container.id };
  },
};

/*
---------------------------------------
COMMAND HANDLER
---------------------------------------
*/

const handleCommand = async (msg) => {
  const { request_id, command, payload } = msg;
  log("📥 Command", { command });
  if (!handlers[command]) {
    log("⚠️ Unsupported", { command });
    return sendJson({ type: "response", request_id, data: { error: "Unsupported command" } });
  }
  try {
    const result = await handlers[command](payload || {});
    sendJson({ type: "response", request_id, data: result });
  } catch (err) {
    sendJson({ type: "response", request_id, data: { error: err.message } });
  }
};

/*
---------------------------------------
CONNECT
---------------------------------------
*/

const connect = () => {
  if (shuttingDown) return;
  if (isConnected()) return;
  if (isConnecting) return;

  clearReconnectTimer();
  isConnecting = true;

  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }

  log("🔌 Connecting...");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    isConnecting = false;
    reconnectDelay = 1000;
    lastConnectedAt = Date.now();
    log("✅ Connected");
    sendJson({ type: "register", device_token: deviceToken });
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "command") await handleCommand(msg);
    } catch (e) {
      log("❌ Parse error", { error: e.message });
    }
  });

  ws.on("close", () => {
    isConnecting = false;
    const timeSinceConnect = Date.now() - lastConnectedAt;
    if (timeSinceConnect < CONNECT_COOLDOWN) {
      clearReconnectTimer();
      log("🔁 Brief disconnect — waiting 3s");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 3000);
    } else {
      scheduleReconnect();
    }
  });

  ws.on("error", (err) => {
    isConnecting = false;
    log("⚠️ WS Error", { error: err.message });
  });
};

/*
---------------------------------------
IMMEDIATE RECONNECT
---------------------------------------
*/

const immediateReconnect = (reason) => {
  if (shuttingDown) return;
  if (isConnected()) return;
  if (isConnecting) return;

  const timeSinceConnect = Date.now() - lastConnectedAt;
  if (timeSinceConnect < CONNECT_COOLDOWN) return;

  log(`⚡ ${reason} — reconnecting immediately`);
  clearReconnectTimer();
  reconnectDelay = 1000;
  connect();
};

/*
---------------------------------------
SCHEDULED RECONNECT (with backoff)
---------------------------------------
*/

const scheduleReconnect = () => {
  if (shuttingDown || reconnectTimer) return;
  log("🔁 Reconnecting...", { delay: reconnectDelay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
  }, reconnectDelay);
};

/*
---------------------------------------
SLEEP / WAKE DETECTION
---------------------------------------
*/

const SLEEP_CHECK_INTERVAL = 2000;
const SLEEP_THRESHOLD = SLEEP_CHECK_INTERVAL * 2;
let lastTickTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const gap = now - lastTickTime;
  if (gap > SLEEP_THRESHOLD) {
    log(`😴 Wake detected (gap: ${gap}ms)`);
    immediateReconnect("System wake");
  }
  lastTickTime = now;
}, SLEEP_CHECK_INTERVAL);

/*
---------------------------------------
INTERNET RECOVERY DETECTION
Simply checks: do we have internet but no connection?
No state flags — works reliably every time.
---------------------------------------
*/

setInterval(() => {
  if (isConnected()) return;

  // Skip during cooldown window
  const timeSinceConnect = Date.now() - lastConnectedAt;
  if (timeSinceConnect < CONNECT_COOLDOWN) return;

  // Skip if already attempting or a retry is scheduled
  if (isConnecting || reconnectTimer) return;

  dns.lookup("1.1.1.1", (err) => {
    if (!err) {
      // Internet is up but we have no connection — reconnect immediately
      immediateReconnect("Internet available, not connected");
    }
  });
}, 2000);

/*
---------------------------------------
SHUTDOWN
---------------------------------------
*/

process.on("SIGINT", () => { shuttingDown = true; process.exit(0); });
process.on("SIGTERM", () => { shuttingDown = true; process.exit(0); });

/*
---------------------------------------
START
---------------------------------------
*/

connect();
