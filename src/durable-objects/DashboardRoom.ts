export class DashboardRoom {
  private connections: Set<WebSocket> = new Set();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      this.broadcast(message);
      return new Response("OK");
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleConnection(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleConnection(ws: WebSocket): void {
    // Accept the connection
    ws.accept();
    this.connections.add(ws);

    // Send welcome message
    ws.send(JSON.stringify({ type: "connected", clients: this.connections.size }));

    // Handle messages from client
    ws.addEventListener("message", (event) => {
      // For now, we don't need client->server messages
      // But we could add commands here later
      console.log("Received:", event.data);
    });

    // Handle disconnection
    ws.addEventListener("close", () => {
      this.connections.delete(ws);
    });

    ws.addEventListener("error", () => {
      this.connections.delete(ws);
    });
  }

  private broadcast(message: string): void {
    for (const ws of this.connections) {
      try {
        ws.send(message);
      } catch (e) {
        // Connection might be closed, remove it
        this.connections.delete(ws);
      }
    }
  }
}
