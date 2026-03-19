const { v4: uuidv4 } = require("uuid");

const deviceConnections = new Map();
const socketToDevice = new Map();
const pendingRequests = new Map();

function registerConnection(deviceId, socket) {
  const existingSocket = deviceConnections.get(deviceId);

  if (existingSocket && existingSocket !== socket) {
    try {
      existingSocket.close(4000, "Replaced by a newer connection");
    } catch (error) {
      // Ignore close errors during connection replacement.
    }
  }

  deviceConnections.set(deviceId, socket);
  socketToDevice.set(socket, deviceId);
}

function unregisterConnection(socket) {
  const deviceId = socketToDevice.get(socket);

  if (!deviceId) {
    return null;
  }

  socketToDevice.delete(socket);

  const activeSocket = deviceConnections.get(deviceId);
  if (activeSocket === socket) {
    deviceConnections.delete(deviceId);
  }

  return deviceId;
}

function getConnection(deviceId) {
  return deviceConnections.get(deviceId) || null;
}

function generateDeviceToken() {
  return uuidv4();
}

function createPendingRequest(deviceId, timeoutMs = 120000) {
  const requestId = uuidv4();

  let cleanup;

  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      const error = new Error("Timed out waiting for agent response");
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);

    cleanup = () => clearTimeout(timeout);

    pendingRequests.set(requestId, {
      deviceId,
      resolve,
      reject,
      cleanup
    });
  });

  return {
    requestId,
    promise
  };
}

function resolvePendingRequest(message) {
  const requestId = message.request_id;
  if (!requestId) {
    return false;
  }

  const pendingRequest = pendingRequests.get(requestId);
  if (!pendingRequest) {
    return false;
  }

  pendingRequest.cleanup();
  pendingRequests.delete(requestId);
  pendingRequest.resolve(message);
  return true;
}

function rejectPendingRequestsForDevice(deviceId, reason = "Device disconnected") {
  for (const [requestId, pendingRequest] of pendingRequests.entries()) {
    if (pendingRequest.deviceId !== deviceId) {
      continue;
    }

    pendingRequest.cleanup();
    pendingRequests.delete(requestId);
    const error = new Error(reason);
    error.statusCode = 503;
    pendingRequest.reject(error);
  }
}

function rejectPendingRequest(requestId, reason = "Request failed") {
  const pendingRequest = pendingRequests.get(requestId);
  if (!pendingRequest) {
    return false;
  }

  pendingRequest.cleanup();
  pendingRequests.delete(requestId);
  const error = new Error(reason);
  error.statusCode = 503;
  pendingRequest.reject(error);
  return true;
}

module.exports = {
  createPendingRequest,
  deviceConnections,
  generateDeviceToken,
  getConnection,
  registerConnection,
  rejectPendingRequest,
  rejectPendingRequestsForDevice,
  resolvePendingRequest,
  unregisterConnection
};
