const express = require("express");
const { WebSocket } = require("ws");
const {
  createPendingRequest,
  generateDeviceToken,
  getConnection,
  rejectPendingRequest
} = require("../deviceManager");
const { supabase } = require("../supabase");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, user_id, device_name, device_token, status, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    res.json({ devices: data });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { device_name: deviceName } = req.body;

    if (!deviceName || typeof deviceName !== "string" || !deviceName.trim()) {
      return res.status(400).json({ error: "device_name is required" });
    }

    const payload = {
      user_id: req.user.id,
      device_name: deviceName.trim(),
      device_token: generateDeviceToken(),
      status: "offline"
    };

    const { data, error } = await supabase
      .from("devices")
      .insert(payload)
      .select("id, user_id, device_name, device_token, status, created_at")
      .single();

    if (error) {
      throw error;
    }

    res.status(201).json({ device: data });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/command", async (req, res, next) => {
  try {
    const { id: deviceId } = req.params;
    const { command, payload = {} } = req.body;

    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "command is required" });
    }

    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .select("id, user_id, device_name, status")
      .eq("id", deviceId)
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (deviceError) {
      throw deviceError;
    }

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    const agentSocket = getConnection(deviceId);

    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      return res.status(503).json({ error: "Device is offline" });
    }

    const { requestId, promise } = createPendingRequest(deviceId);

    try {
      agentSocket.send(
        JSON.stringify({
          type: "command",
          request_id: requestId,
          command,
          payload
        })
      );
    } catch (sendError) {
      rejectPendingRequest(requestId, "Failed to send command to device");
      throw sendError;
    }

    const agentResponse = await promise;

    res.json({
      device_id: deviceId,
      request_id: requestId,
      response: agentResponse
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
