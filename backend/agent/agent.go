package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"os/signal"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/gorilla/websocket"
)

const (
	WS_URL          = "wss://dockmon.onrender.com/agent"
	GITHUB_REPO     = "Hargun-singhh/DockMon"
	CURRENT_VERSION = "1.0.5"
	PING_INTERVAL   = 15 * time.Second
	PONG_TIMEOUT    = 8 * time.Second
	MAX_BACKOFF     = 5 * time.Second
	CONNECT_COOLDOWN = 4 * time.Second
)

type Agent struct {
	mu              sync.Mutex
	conn            *websocket.Conn
	docker          *client.Client
	deviceToken     string
	reconnectDelay  time.Duration
	lastConnectedAt time.Time
	isConnecting    bool
	shuttingDown    bool
}

func log(msg string) {
	fmt.Printf("[%s] %s\n", time.Now().UTC().Format(time.RFC3339), msg)
}

func logf(format string, args ...interface{}) {
	log(fmt.Sprintf(format, args...))
}

/*
---------------------------------------
AUTO UPDATE
---------------------------------------
*/

type GithubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

func checkAndUpdate() {
	return
}

/*
---------------------------------------
TOKEN
---------------------------------------
*/

func getToken() string {
	home, _ := os.UserHomeDir()
	configPath := filepath.Join(home, ".dockmon", "config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return ""
	}
	var config map[string]string
	if err := json.Unmarshal(data, &config); err != nil {
		return ""
	}
	return config["deviceToken"]
}

/*
---------------------------------------
DOCKER HANDLERS
---------------------------------------
*/

func (a *Agent) handleCommand(command string, payload map[string]interface{}) interface{} {
	ctx := context.Background()

	switch command {
	case "list_containers":
		containers, err := a.docker.ContainerList(ctx, container.ListOptions{All: true})
		if err != nil {
			return map[string]string{"error": err.Error()}
		}
		result := make([]map[string]interface{}, len(containers))
		for i, c := range containers {
			result[i] = map[string]interface{}{
				"id": c.ID, "names": c.Names,
				"image": c.Image, "state": c.State, "status": c.Status,
			}
		}
		return result

	case "start_container":
		id, _ := payload["container_id"].(string)
		if err := a.docker.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
			return map[string]string{"error": err.Error()}
		}
		return map[string]bool{"success": true}

	case "stop_container":
		id, _ := payload["container_id"].(string)
		if err := a.docker.ContainerStop(ctx, id, container.StopOptions{}); err != nil {
			return map[string]string{"error": err.Error()}
		}
		return map[string]bool{"success": true}

	case "restart_container":
		id, _ := payload["container_id"].(string)
		if err := a.docker.ContainerRestart(ctx, id, container.StopOptions{}); err != nil {
			return map[string]string{"error": err.Error()}
		}
		return map[string]bool{"success": true}

	case "remove_container":
		id, _ := payload["container_id"].(string)
		if err := a.docker.ContainerRemove(ctx, id, container.RemoveOptions{Force: true}); err != nil {
			return map[string]string{"error": err.Error()}
		}
		return map[string]bool{"success": true}

	case "logs":
		id, _ := payload["container_id"].(string)
		reader, err := a.docker.ContainerLogs(ctx, id, container.LogsOptions{
			ShowStdout: true, ShowStderr: true, Timestamps: true, Tail: "500",
		})
		if err != nil {
			return map[string]string{"error": err.Error()}
		}
		defer reader.Close()
		data, _ := io.ReadAll(reader)
		return string(data)

	case "stats":
		id, _ := payload["container_id"].(string)
		resp, err := a.docker.ContainerStats(ctx, id, false)
		if err != nil {
			return map[string]string{"error": err.Error()}
		}
		defer resp.Body.Close()
		var stats types.StatsJSON
		if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
			return map[string]string{"error": err.Error()}
		}
		cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
		systemDelta := float64(stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage)
		cpuCount := float64(stats.CPUStats.OnlineCPUs)
		if cpuCount == 0 {
			cpuCount = float64(len(stats.CPUStats.CPUUsage.PercpuUsage))
		}
		cpu := 0.0
		if systemDelta > 0 && cpuDelta > 0 {
			cpu = (cpuDelta / systemDelta) * cpuCount * 100
		}
		return map[string]interface{}{
			"cpu_percent":  fmt.Sprintf("%.2f", cpu),
			"memory_usage": stats.MemoryStats.Usage,
			"memory_limit": stats.MemoryStats.Limit,
		}

	case "list_images":
		images, err := a.docker.ImageList(ctx, types.ImageListOptions{})
		if err != nil {
			return map[string]string{"error": err.Error()}
		}
		return images

	default:
		return map[string]string{"error": "Unsupported command"}
	}
}

/*
---------------------------------------
SEND
---------------------------------------
*/

func (a *Agent) send(v interface{}) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn == nil {
		return fmt.Errorf("not connected")
	}
	a.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return a.conn.WriteJSON(v)
}

/*
---------------------------------------
CONNECT
---------------------------------------
*/

func (a *Agent) connect() {
	a.mu.Lock()
	if a.shuttingDown || a.isConnecting {
		a.mu.Unlock()
		return
	}
	if a.conn != nil {
		a.conn.Close()
		a.conn = nil
	}
	a.isConnecting = true
	a.mu.Unlock()

	log("🔌 Connecting...")

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(WS_URL, nil)

	a.mu.Lock()
	a.isConnecting = false
	a.mu.Unlock()

	if err != nil {
		logf("⚠️ WS Error: %s", err)
		a.scheduleReconnect()
		return
	}

	a.mu.Lock()
	a.conn = conn
	a.lastConnectedAt = time.Now()
	a.reconnectDelay = time.Second
	a.mu.Unlock()

	log("✅ Connected")

	conn.WriteJSON(map[string]string{
		"type":         "register",
		"device_token": a.deviceToken,
	})

	// Heartbeat in background
	go a.heartbeat(conn)

	// Read loop
	for {
		var msg map[string]interface{}
		if err := conn.ReadJSON(&msg); err != nil {
			logf("⚠️ Read error: %s", err)
			break
		}

		msgType, _ := msg["type"].(string)
		if msgType == "ping" {
			continue
		}
		if msgType == "command" {
			go func(m map[string]interface{}) {
				requestID, _ := m["request_id"].(string)
				command, _ := m["command"].(string)
				payload, _ := m["payload"].(map[string]interface{})
				if payload == nil {
					payload = map[string]interface{}{}
				}
				logf("📥 Command {\"command\":\"%s\"}", command)
				result := a.handleCommand(command, payload)
				a.send(map[string]interface{}{
					"type": "response", "request_id": requestID, "data": result,
				})
			}(msg)
		}
	}

	a.mu.Lock()
	a.conn = nil
	timeSinceConnect := time.Since(a.lastConnectedAt)
	a.mu.Unlock()

	if timeSinceConnect < CONNECT_COOLDOWN {
		log("🔁 Brief disconnect — waiting 3s")
		time.Sleep(3 * time.Second)
		go a.connect()
	} else {
		a.scheduleReconnect()
	}
}

/*
---------------------------------------
HEARTBEAT
---------------------------------------
*/

func (a *Agent) heartbeat(conn *websocket.Conn) {
	ticker := time.NewTicker(PING_INTERVAL)
	defer ticker.Stop()

	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(PING_INTERVAL + PONG_TIMEOUT))
		return nil
	})

	for range ticker.C {
		a.mu.Lock()
		current := a.conn
		a.mu.Unlock()
		if current != conn {
			return
		}

		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
			logf("💔 Ping failed: %s", err)
			conn.Close()
			return
		}
		conn.SetReadDeadline(time.Now().Add(PONG_TIMEOUT))
	}
}

/*
---------------------------------------
RECONNECT
---------------------------------------
*/

func (a *Agent) scheduleReconnect() {
	a.mu.Lock()
	delay := a.reconnectDelay
	newDelay := a.reconnectDelay * 3 / 2
	if newDelay > MAX_BACKOFF {
		newDelay = MAX_BACKOFF
	}
	a.reconnectDelay = newDelay
	a.mu.Unlock()

	logf("🔁 Reconnecting... {\"delay\":%d}", delay.Milliseconds())
	time.Sleep(delay)
	go a.connect()
}

func (a *Agent) immediateReconnect(reason string) {
	a.mu.Lock()
	if a.shuttingDown || a.isConnecting || a.conn != nil {
		a.mu.Unlock()
		return
	}
	timeSinceConnect := time.Since(a.lastConnectedAt)
	a.mu.Unlock()

	if timeSinceConnect < CONNECT_COOLDOWN {
		return
	}

	logf("⚡ %s — reconnecting immediately", reason)
	go a.connect()
}

/*
---------------------------------------
SLEEP / WAKE DETECTION
---------------------------------------
*/

func (a *Agent) watchSleep() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	last := time.Now()

	for t := range ticker.C {
		gap := t.Sub(last)
		if gap > 4*time.Second {
			logf("😴 Wake detected (gap: %dms)", gap.Milliseconds())
			a.mu.Lock()
			if a.conn != nil {
				a.conn.Close()
				a.conn = nil
			}
			a.mu.Unlock()
			a.immediateReconnect("System wake")
		}
		last = t
	}
}

/*
---------------------------------------
INTERNET RECOVERY DETECTION
Uses TCP dial to 1.1.1.1:443 — works even when DNS is broken
---------------------------------------
*/

func (a *Agent) watchInternet() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		a.mu.Lock()
		connected := a.conn != nil
		timeSinceConnect := time.Since(a.lastConnectedAt)
		isConnecting := a.isConnecting
		a.mu.Unlock()

		if connected || isConnecting || timeSinceConnect < CONNECT_COOLDOWN {
			continue
		}

		// TCP dial to 1.1.1.1 — faster and more reliable than DNS lookup
		conn, err := net.DialTimeout("tcp", "1.1.1.1:443", 2*time.Second)
		if err == nil {
			conn.Close()
			a.immediateReconnect("Internet available, not connected")
		}
	}
}

/*
---------------------------------------
MAIN
---------------------------------------
*/

func main() {
	checkAndUpdate()

	token := getToken()
	if token == "" {
		fmt.Println("❌ No DEVICE_TOKEN found.")
		fmt.Println("👉 Run: dockmon-agent login")
		os.Exit(1)
	}

	dockerClient, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		fmt.Printf("❌ Docker error: %s\n", err)
		os.Exit(1)
	}
	defer dockerClient.Close()

	agent := &Agent{
		docker:         dockerClient,
		deviceToken:    token,
		reconnectDelay: time.Second,
	}

	go agent.connect()
	go agent.watchSleep()
	go agent.watchInternet()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	agent.mu.Lock()
	agent.shuttingDown = true
	if agent.conn != nil {
		agent.conn.Close()
	}
	agent.mu.Unlock()

	log("👋 Agent stopped")
}
