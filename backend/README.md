# DockMon Backend

Production-ready Node.js backend for the DockMon mobile app.

## Folder structure

```text
backend/
  .env.example
  deviceManager.js
  package.json
  README.md
  server.js
  supabase-schema.sql
  supabase.js
  routes/
    devices.js
```

## Features

- Verifies Supabase JWTs on every API request
- Registers laptop devices for authenticated users
- Accepts laptop-agent WebSocket connections at `/agent`
- Tracks online and offline device state in Supabase
- Forwards commands from the mobile app to connected agents
- Waits for agent responses and returns them through the REST API

## Environment variables

```bash
PORT=3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=your-supabase-jwt-secret
```

`JWT_SECRET` should match the JWT secret configured in your Supabase project settings.

## Supabase setup

1. Open the Supabase SQL editor.
2. Run the SQL in `supabase-schema.sql`.
3. Confirm your iOS app signs users in with Supabase Auth.
4. Use the issued access token as the `Bearer` token when calling this backend.

## Local development

```bash
cd backend
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## Render deployment

1. Push this repository to GitHub.
2. In Render, create a new `Web Service`.
3. Set the root directory to `backend`.
4. Use:
   - Build command: `npm install`
   - Start command: `npm start`
5. Add environment variables from `.env.example`.
6. Deploy the service.
7. Use your Render service URL for:
   - REST API: `https://your-service.onrender.com`
   - Agent WebSocket: `wss://your-service.onrender.com/agent`

## REST API

### `GET /devices`

Returns all devices for the authenticated user.

Example:

```bash
curl --request GET \
  --url https://your-service.onrender.com/devices \
  --header "Authorization: Bearer SUPABASE_ACCESS_TOKEN"
```

### `POST /devices`

Registers a laptop device and generates a unique `device_token`.

```bash
curl --request POST \
  --url https://your-service.onrender.com/devices \
  --header "Authorization: Bearer SUPABASE_ACCESS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"device_name":"Harsh MacBook Pro"}'
```

### `POST /devices/:id/command`

Sends a command to an online agent and waits for a response.

```bash
curl --request POST \
  --url https://your-service.onrender.com/devices/DEVICE_ID/command \
  --header "Authorization: Bearer SUPABASE_ACCESS_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"command":"list_containers","payload":{}}'
```

## WebSocket message formats

### Agent register message

```json
{
  "type": "register",
  "device_token": "9e02728f-a942-4d25-8e13-a6591f9467f2"
}
```

### Backend registration acknowledgement

```json
{
  "type": "registered",
  "device_id": "24f8af73-d40f-40c0-8f15-3dc90b95bd55",
  "device_name": "Harsh MacBook Pro"
}
```

### Backend command sent to agent

```json
{
  "type": "command",
  "request_id": "4950b62b-c322-4b80-916a-8fe271688c12",
  "command": "list_containers",
  "payload": {}
}
```

### Agent response

The agent should echo `request_id` so the backend can match the response to the waiting API call.

```json
{
  "type": "containers",
  "request_id": "4950b62b-c322-4b80-916a-8fe271688c12",
  "data": [
    {
      "id": "3cc1f2",
      "name": "redis",
      "status": "running"
    }
  ]
}
```

### Example HTTP response from `POST /devices/:id/command`

```json
{
  "device_id": "24f8af73-d40f-40c0-8f15-3dc90b95bd55",
  "request_id": "4950b62b-c322-4b80-916a-8fe271688c12",
  "response": {
    "type": "containers",
    "request_id": "4950b62b-c322-4b80-916a-8fe271688c12",
    "device_id": "24f8af73-d40f-40c0-8f15-3dc90b95bd55",
    "data": [
      {
        "id": "3cc1f2",
        "name": "redis",
        "status": "running"
      }
    ]
  }
}
```

## Notes for production

- Keep the `SUPABASE_SERVICE_ROLE_KEY` server-side only.
- Render terminates TLS, so agents should connect over `wss://`.
- The in-memory connection map is suitable for a single backend instance. If you scale horizontally later, move connection state and request routing into Redis or another shared layer.
