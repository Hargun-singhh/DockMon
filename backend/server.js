require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const devicesRouter = require("./routes/devices");

const {
  registerConnection,
  unregisterConnection,
  resolvePendingRequest,
  rejectPendingRequestsForDevice
} = require("./deviceManager");

const { verifyAuthToken, supabase } = require("./supabase");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: "1mb" }));

/*
------------------------------------------------
OFFLINE GRACE PERIOD
------------------------------------------------
*/
const OFFLINE_GRACE_MS = 8000;
const offlineTimers = new Map();

const scheduleOffline = (deviceId) => {
  if (offlineTimers.has(deviceId)) {
    clearTimeout(offlineTimers.get(deviceId));
  }

  const timer = setTimeout(async () => {
    offlineTimers.delete(deviceId);

    const { error } = await supabase
      .from("devices")
      .update({ status: "offline" })
      .eq("id", deviceId);

    if (error) {
      console.error(`❌ Failed to mark offline: ${deviceId}`, error);
    } else {
      console.log(`🔴 Device marked offline: ${deviceId}`);
    }
  }, OFFLINE_GRACE_MS);

  offlineTimers.set(deviceId, timer);
};

const cancelOffline = (deviceId) => {
  if (offlineTimers.has(deviceId)) {
    clearTimeout(offlineTimers.get(deviceId));
    offlineTimers.delete(deviceId);
  }
};

/*
------------------------------------------------
HEALTH CHECK
------------------------------------------------
*/
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/*
------------------------------------------------
INSTALL SCRIPT
------------------------------------------------
*/
app.get("/install", (_req, res) => {
  res.sendFile(path.join(__dirname, "install.sh"));
});

/*
------------------------------------------------
SERVE AGENT FILE
------------------------------------------------
*/
app.get("/agent.js", (_req, res) => {
  const agentPath = path.join(__dirname, "agent", "agent.js");
  res.sendFile(agentPath, (err) => {
    if (err) {
      console.error("Failed to serve agent.js:", err);
      res.status(404).json({ error: "Agent file not found" });
    }
  });
});

/*
------------------------------------------------
AUTH MIDDLEWARE
------------------------------------------------
*/
app.use(async (req, res, next) => {
  const publicRoutes = ["/health", "/install", "/agent.js"];
  if (publicRoutes.includes(req.path)) return next();

  try {
    const user = await verifyAuthToken(req.headers.authorization);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
});

/*
------------------------------------------------
API ROUTES
------------------------------------------------
*/
app.use("/devices", devicesRouter);

/*
------------------------------------------------
ERROR HANDLER
------------------------------------------------
*/
app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const message = error.message || "Internal server error";
  if (statusCode >= 500) console.error("Server error:", error);
  res.status(statusCode).json({ error: message });
});

/*
------------------------------------------------
WEBSOCKET UPGRADE
------------------------------------------------
*/
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/agent") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

/*
------------------------------------------------
WEBSOCKET CONNECTION
------------------------------------------------
*/
wss.on("connection", (ws) => {
  let registered = false;
  let registeredDevice = null;

  ws.on("message", async (buffer) => {
    try {
      const message = JSON.parse(buffer.toString());

      if (!registered) {
        if (message.type !== "register" || !message.device_token) {
          ws.close(4001, "Expected register message");
          return;
        }

        const { data: device, error } = await supabase
          .from("devices")
          .select("id, device_name")
          .eq("device_token", message.device_token)
          .maybeSingle();

        if (error) {
          console.error("❌ Supabase select error:", error);
          throw error;
        }

        if (!device) {
          console.log("❌ Invalid device token:", message.device_token?.slice(0, 8));
          ws.close(4004, "Invalid device token");
          return;
        }

        registered = true;
        registeredDevice = device;

        cancelOffline(device.id);
        registerConnection(device.id, ws);

        console.log(`✅ Agent connected: ${device.device_name}`);

        // Mark online with error logging
        const { error: updateError } = await supabase
          .from("devices")
          .update({
            status: "online",
            last_seen: new Date().toISOString()
          })
          .eq("id", device.id);

        if (updateError) {
          console.error(`❌ Failed to mark online (${device.device_name}):`, updateError);
        } else {
          console.log(`✅ Marked online in Supabase: ${device.device_name}`);
        }

        ws.send(JSON.stringify({
          type: "registered",
          device_id: device.id,
          device_name: device.device_name
        }));

        return;
      }

      // Keep device online on every message
      if (registeredDevice) {
        const { error: keepAliveError } = await supabase
          .from("devices")
          .update({
            status: "online",
            last_seen: new Date().toISOString()
          })
          .eq("id", registeredDevice.id);

        if (keepAliveError) {
          console.error("❌ Keep-alive update failed:", keepAliveError);
        }
      }

      if (message.type === "ping") return;

      const handled = resolvePendingRequest({
        ...message,
        device_id: registeredDevice.id
      });

      if (!handled) {
        console.log("⚠️ Unhandled agent message", {
          deviceId: registeredDevice.id,
          type: message.type
        });
      }

    } catch (err) {
      console.error("❌ WS message error:", err);
    }
  });

  const interval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 10000);

  ws.on("close", async () => {
    clearInterval(interval);
    const deviceId = unregisterConnection(ws);
    if (!deviceId) return;
    rejectPendingRequestsForDevice(deviceId);
    console.log(`🔌 Agent disconnected: ${deviceId} — waiting ${OFFLINE_GRACE_MS}ms before marking offline`);
    scheduleOffline(deviceId);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error", {
      deviceId: registeredDevice?.id,
      error
    });
  });
});

/*
------------------------------------------------
START SERVER
------------------------------------------------
*/
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 DockMon backend running on port ${PORT}`);
});
