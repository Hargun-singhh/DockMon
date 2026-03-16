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
  res.sendFile(path.join(__dirname, "agents", "agent.js"));
});

/*
------------------------------------------------
AUTH MIDDLEWARE
------------------------------------------------
*/

app.use(async (req, res, next) => {

  // Public routes
  if (
    req.path === "/health" ||
    req.path === "/install" ||
    req.path === "/agent.js"
  ) {
    return next();
  }

  try {

    const user = await verifyAuthToken(req.headers.authorization);
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

  if (statusCode >= 500) {
    console.error(error);
  }

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
WEBSOCKET CONNECTION (AGENTS)
------------------------------------------------
*/

wss.on("connection", (ws) => {

  let registeredDevice = null;

  ws.once("message", async (buffer) => {

    try {

      const message = JSON.parse(buffer.toString());

      if (message.type !== "register" || !message.device_token) {
        ws.close(4001, "Expected register message with device_token");
        return;
      }

      const { data: device, error } = await supabase
        .from("devices")
        .select("id, device_name")
        .eq("device_token", message.device_token)
        .maybeSingle();

      if (error) throw error;

      if (!device) {
        ws.close(4004, "Invalid device token");
        return;
      }

      registeredDevice = device;

      registerConnection(device.id, ws);

      await supabase
        .from("devices")
        .update({ status: "online" })
        .eq("id", device.id);

      ws.send(JSON.stringify({
        type: "registered",
        device_id: device.id,
        device_name: device.device_name
      }));

      /*
      ---------------------------------------------
      RECEIVE AGENT RESPONSES
      ---------------------------------------------
      */

      ws.on("message", async (messageBuffer) => {

        try {

          const agentMessage = JSON.parse(messageBuffer.toString());

          const handled = resolvePendingRequest({
            ...agentMessage,
            device_id: device.id
          });

          if (!handled) {
            console.log("Unsolicited message from agent", {
              deviceId: device.id,
              type: agentMessage.type
            });
          }

        } catch (err) {
          console.error("Failed to process agent message", err);
        }

      });

    } catch (error) {

      console.error("Agent registration failed", error);
      ws.close(1011, "Registration failed");

    }

  });

  /*
  ------------------------------------------------
  AGENT DISCONNECT
  ------------------------------------------------
  */

  ws.on("close", async () => {

    const deviceId = unregisterConnection(ws);

    if (!deviceId) return;

    rejectPendingRequestsForDevice(deviceId);

    try {

      await supabase
        .from("devices")
        .update({ status: "offline" })
        .eq("id", deviceId);

    } catch (err) {

      console.error("Failed to mark device offline", err);

    }

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
  console.log(`DockMon backend running on port ${PORT}`);
});