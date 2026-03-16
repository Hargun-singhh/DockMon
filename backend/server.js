require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const devicesRouter = require("./routes/devices");
const {
  registerConnection,
  rejectPendingRequestsForDevice,
  resolvePendingRequest,
  unregisterConnection
} = require("./deviceManager");
const { supabase, verifyAuthToken } = require("./supabase");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(async (req, res, next) => {
  if (req.path === "/health") {
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

app.use("/devices", devicesRouter);

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const message = error.message || "Internal server error";

  if (statusCode >= 500) {
    console.error(error);
  }

  res.status(statusCode).json({ error: message });
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/agent") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

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

      if (error) {
        throw error;
      }

      if (!device) {
        ws.close(4004, "Invalid device token");
        return;
      }

      registeredDevice = device;
      registerConnection(device.id, ws);

      const { error: updateError } = await supabase
        .from("devices")
        .update({ status: "online" })
        .eq("id", device.id);

      if (updateError) {
        throw updateError;
      }

      ws.send(
        JSON.stringify({
          type: "registered",
          device_id: device.id,
          device_name: device.device_name
        })
      );

      ws.on("message", async (messageBuffer) => {
        try {
          const agentMessage = JSON.parse(messageBuffer.toString());
          const handled = resolvePendingRequest({
            ...agentMessage,
            device_id: device.id
          });

          if (!handled) {
            console.log("Received unsolicited agent message", {
              deviceId: device.id,
              type: agentMessage.type || "unknown"
            });
          }
        } catch (messageError) {
          console.error("Failed to process agent message", messageError);
        }
      });
    } catch (error) {
      console.error("Failed to register agent", error);
      ws.close(1011, "Registration failed");
    }
  });

  ws.on("close", async () => {
    const deviceId = unregisterConnection(ws);
    if (!deviceId) {
      return;
    }

    rejectPendingRequestsForDevice(deviceId);

    try {
      const { error } = await supabase
        .from("devices")
        .update({ status: "offline" })
        .eq("id", deviceId);

      if (error) {
        throw error;
      }
    } catch (updateError) {
      console.error("Failed to mark device offline", updateError);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error", {
      deviceId: registeredDevice?.id,
      error
    });
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`DockMon backend listening on port ${PORT}`);
});
