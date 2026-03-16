
require("dotenv").config();

const WebSocket = require("ws");
const Docker = require("dockerode");

const WS_URL = "wss://dockmon.onrender.com/agent";
const RECONNECT_DELAY_MS = 5000;

const deviceToken = process.env.DEVICE_TOKEN;

if (!deviceToken) {
  console.error("Missing DEVICE_TOKEN environment variable");
  process.exit(1);
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

let ws;
let reconnectTimer;
let shuttingDown = false;


const log = (message, meta) => {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
};



const sendJson = (payload) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};


const formatContainer = (container) => ({
  id: container.Id,
  names: container.Names,
  image: container.Image,
  image_id: container.ImageID,
  state: container.State,
  status: container.Status,
  created: container.Created,
  ports: container.Ports,
  labels: container.Labels
});


const normalizeLogs = async (container) => {

  const stream = await container.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: 200
  });

  if (!stream) return "No logs available";

  const logs = stream.toString("utf8");

  if (!logs || logs.trim().length === 0) {
    return "No logs available";
  }

  return logs;

};

const getStats = async (container) =>
  new Promise((resolve, reject) => {

    container.stats({ stream: false }, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });

  });


const handlers = {

  async list_containers() {

    const containers = await docker.listContainers({ all: true });
    return containers.map(formatContainer);

  },

  async start_container(payload) {

    const container = docker.getContainer(payload.container_id);
    await container.start();

    return {
      success: true,
      container_id: payload.container_id
    };

  },

  async stop_container(payload) {

    const container = docker.getContainer(payload.container_id);
    await container.stop();

    return {
      success: true,
      container_id: payload.container_id
    };

  },

  async restart_container(payload) {

    const container = docker.getContainer(payload.container_id);
    await container.restart();

    return {
      success: true,
      container_id: payload.container_id
    };

  },

  async remove_container(payload) {

    const container = docker.getContainer(payload.container_id);
    await container.remove({ force: true });

    return {
      success: true,
      container_id: payload.container_id
    };

  },

async logs(payload) {

  const container = docker.getContainer(payload.container_id)

  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: 1000
  })

  if (!buffer || buffer.length === 0) {
    return "No logs available"
  }

  let offset = 0
  let result = ""

  while (offset + 8 < buffer.length) {

    const size = buffer.readUInt32BE(offset + 4)

    const start = offset + 8
    const end = start + size

    if (end > buffer.length) break

    const chunk = buffer.slice(start, end).toString("utf8")

    result += chunk

    offset = end
  }

  return result.length > 0 ? result : "No logs available"

},

  async stats(payload) {

  const container = docker.getContainer(payload.container_id)

  const stats = await getStats(container)

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage

  const systemDelta =
    stats.cpu_stats.system_cpu_usage -
    stats.precpu_stats.system_cpu_usage

  const cpuCount =
    stats.cpu_stats.online_cpus ||
    stats.cpu_stats.cpu_usage.percpu_usage.length

  let cpuPercent = 0

  if (systemDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100
  }

  return {
    container_id: payload.container_id,

    cpu_percent: Number(cpuPercent.toFixed(2)),

    memory_usage: stats.memory_stats.usage,

    memory_limit: stats.memory_stats.limit,

    network_rx: Object.values(stats.networks || {})
      .reduce((acc, n) => acc + (n.rx_bytes || 0), 0),

    network_tx: Object.values(stats.networks || {})
      .reduce((acc, n) => acc + (n.tx_bytes || 0), 0)
  }

},

  async list_images() {

    const images = await docker.listImages();

    return images.map(img => ({
      id: img.Id,
      tags: img.RepoTags,
      size: img.Size,
      created: img.Created
    }));

  },

  async pull_image(payload) {

  const image = payload.image.toLowerCase()

  return new Promise((resolve, reject) => {

    docker.pull(image, (err, stream) => {

      if (err) return reject(err)

      docker.modem.followProgress(stream, (err) => {

        if (err) reject(err)
        else resolve({
          success: true,
          image
        })

      })

    })

  })

},

 async run_container(payload) {

  const image = payload.image.toLowerCase()

  let portBindings = {}
  let exposedPorts = {}

  if (payload.ports) {

    payload.ports.forEach(p => {

      const [host, container] = p.split(":")

      const key = `${container}/tcp`

      exposedPorts[key] = {}

      portBindings[key] = [
        { HostPort: host }
      ]

    })

  }

  const container = await docker.createContainer({

    Image: image,
    name: payload.name,

    ExposedPorts: exposedPorts,

    HostConfig: {
      PortBindings: portBindings
    }

  })

  await container.start()

  return {
    success: true,
    container_id: container.id
  }

}

};



const validatePayload = (command, payload = {}) => {

  if (command === "list_containers") return payload;
  if (command === "list_images") return payload;

  if (!payload.container_id && !payload.image) {
    throw new Error(`Missing payload for command: ${command}`);
  }

  return payload;

};


const handleCommand = async (message) => {

  const { request_id: requestId, command, payload } = message;

  log("Command received", { request_id: requestId, command });

  if (!handlers[command]) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const result = await handlers[command](validatePayload(command, payload));

  log("Docker command executed", { request_id: requestId, command });

  sendJson({
    type: "response",
    request_id: requestId,
    data: result
  });

};

/*
------------------------------------------------
RECONNECT
------------------------------------------------
*/

const scheduleReconnect = () => {

  if (shuttingDown || reconnectTimer) return;

  log("Connection lost / reconnecting", {
    retry_in_ms: RECONNECT_DELAY_MS
  });

  reconnectTimer = setTimeout(() => {

    reconnectTimer = undefined;
    connect();

  }, RECONNECT_DELAY_MS);

};

/*
------------------------------------------------
CONNECT
------------------------------------------------
*/

const connect = () => {

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {

    log("Connected to backend");

    sendJson({
      type: "register",
      device_token: deviceToken
    });

    log("Registered device");

  });

  ws.on("message", async (raw) => {

    try {

      const message = JSON.parse(raw.toString());

      if (message.type !== "command") return;

      await handleCommand(message);

    } catch (error) {

      const parsed = (() => {

        try {
          return JSON.parse(raw.toString());
        } catch {
          return {};
        }

      })();

      console.error("Failed to process message", error.message);

      if (parsed.request_id) {

        sendJson({
          type: "response",
          request_id: parsed.request_id,
          data: { error: error.message }
        });

      }

    }

  });

  ws.on("close", scheduleReconnect);

  ws.on("error", (error) => {
    console.error("WebSocket error", error.message);
  });

};

/*
------------------------------------------------
SHUTDOWN
------------------------------------------------
*/

const shutdown = () => {

  shuttingDown = true;

  if (reconnectTimer) clearTimeout(reconnectTimer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  process.exit(0);

};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/*
------------------------------------------------
START
------------------------------------------------
*/

connect();