import { WebSocketServer, WebSocket, RawData } from "ws";
import * as http from "http";

interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
}

declare module 'ws' {
    interface WebSocket {
        isAlive: boolean;
    }
}

type RoomId = string;

interface JoinMessage {
    type: "join";
    payload: { roomId: RoomId };
}

interface ChatMessage {
    type: "chat";
    payload: { message: string };
}

interface IdentifyMessage {
    type: "identify";
    payload: { name: string };
}

type IncomingMessage = JoinMessage | ChatMessage | IdentifyMessage;

const DEFAULT_ROOM_ID: RoomId = "broadcast";

const port = Number(process.env.PORT) || 8080;
const serverSessionId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

const httpServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse<http.IncomingMessage>) => {
    // Simple health endpoint so PaaS HTTP probes succeed
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
});

const wss = new WebSocketServer({ server: httpServer });

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        const extWs = ws as ExtendedWebSocket;
        if (extWs.isAlive === false) {
            return extWs.terminate();
        }
        extWs.isAlive = false;
        extWs.ping();
    });
}, 5000); // Ping every 5 seconds

wss.on('close', () => {
    clearInterval(interval);
});

const roomIdToClients: Map<RoomId, Set<WebSocket>> = new Map();
const clientToRoomId: Map<WebSocket, RoomId> = new Map();
const roomIdToHistory: Map<RoomId, string[]> = new Map();
const MAX_HISTORY = 100;
const clientToName: Map<WebSocket, string> = new Map();
const clientToUserId: Map<WebSocket, string> = new Map();

function isNameTaken(name: string): boolean {
    const target = name.trim().toLowerCase();
    for (const existing of clientToName.values()) {
        if (existing.trim().toLowerCase() === target) return true;
    }
    return false;
}

function ensureRoomExists(roomId: RoomId): Set<WebSocket> {
    let room = roomIdToClients.get(roomId);
    if (!room) {
        room = new Set<WebSocket>();
        roomIdToClients.set(roomId, room);
    }
    if (!roomIdToHistory.has(roomId)) {
        roomIdToHistory.set(roomId, []);
    }
    return room;
}

function joinRoom(socket: WebSocket, roomId: RoomId): void {
    const currentRoomId = clientToRoomId.get(socket);
    if (currentRoomId && currentRoomId === roomId) return;

    if (currentRoomId) {
        const currentRoom = roomIdToClients.get(currentRoomId);
        currentRoom?.delete(socket);
        // notify previous room of updated count
        broadcastRoomState(currentRoomId);
        // Clear history if broadcast room is now empty
        if (currentRoom?.size === 0 && currentRoomId === DEFAULT_ROOM_ID) {
            roomIdToHistory.delete(currentRoomId);
        }
    }

    const newRoom = ensureRoomExists(roomId);
    newRoom.add(socket);
    clientToRoomId.set(socket, roomId);
    // notify new room of updated count
    broadcastRoomState(roomId);

    // announce join message to room
    const name = clientToName.get(socket) ?? "Someone";
    const notice = JSON.stringify({ type: "system", payload: { message: `${name} joined`, roomId, timestamp: Date.now() } });
    broadcastToRoom(roomId, notice);
}

function broadcastToRoom(roomId: RoomId, text: string): void {
    const room = roomIdToClients.get(roomId);
    if (!room) return;
    for (const client of room) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(text);
        }
    }
}

function appendToHistory(roomId: RoomId, text: string): void {
    const history = roomIdToHistory.get(roomId) ?? [];
    history.push(text);
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }
    roomIdToHistory.set(roomId, history);
}

function getMemberCount(roomId: RoomId): number {
    return roomIdToClients.get(roomId)?.size ?? 0;
}

function broadcastRoomState(roomId: RoomId): void {
    const payload = JSON.stringify({
        type: "room_state",
        payload: { roomId, memberCount: getMemberCount(roomId) }
    });
    broadcastToRoom(roomId, payload);
}

// Note: We intentionally do NOT send history to clients to avoid exposing
// past messages to new joiners.

wss.on("connection", (socket: WebSocket) => {
    const extSocket = socket as ExtendedWebSocket;
    extSocket.isAlive = true;
    extSocket.on('pong', () => {
        extSocket.isAlive = true;
    });
    // Send server info immediately on connection
    extSocket.send(JSON.stringify({ type: "server_info", payload: { sessionId: serverSessionId } }));
    // Require identity before joining rooms or chatting
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "require_identity" }));
    }

    socket.on("close", () => {
        const roomId = clientToRoomId.get(socket);
        if (roomId) {
            roomIdToClients.get(roomId)?.delete(socket);
            clientToRoomId.delete(socket);
            broadcastRoomState(roomId);
            // Clear history if broadcast room is now empty
            if (roomIdToClients.get(roomId)?.size === 0 && roomId === DEFAULT_ROOM_ID) {
                roomIdToHistory.delete(roomId);
            }
            const name = clientToName.get(socket) ?? "Someone";
            const notice = JSON.stringify({ type: "system", payload: { message: `${name} left`, roomId, timestamp: Date.now() } });
            broadcastToRoom(roomId, notice);
        }
        clientToName.delete(socket);
        (socket as ExtendedWebSocket).isAlive = false;
    });

    socket.on("message", (data: RawData) => {
        const text = data.toString();

        // Try to parse protocol JSON; if not JSON, treat as raw chat to current room
        try {
            const parsed = JSON.parse(text) as IncomingMessage;
            if (parsed.type === "join") {
                if (!clientToName.has(socket)) {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: "error", payload: { code: "NOT_IDENTIFIED" } }));
                    }
                    return;
                }
                const nextRoomId = parsed.payload?.roomId?.trim() || DEFAULT_ROOM_ID;
                joinRoom(socket, nextRoomId);
                return;
            }
            if (parsed.type === "identify") {
                const nextName = String(parsed.payload?.name ?? "").trim();
                if (nextName.length === 0) return;
                const userId = Math.random().toString(36).substring(2, 10);
                clientToUserId.set(socket, userId);
                clientToName.set(socket, nextName);
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "identity", payload: { name: nextName, userId } }));
                }
                return;
            }
            if (parsed.type === "chat") {
                if (!clientToName.has(socket)) {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: "error", payload: { code: "NOT_IDENTIFIED" } }));
                    }
                    return;
                }
                const roomId = clientToRoomId.get(socket) || DEFAULT_ROOM_ID;
                const messageText = String(parsed.payload?.message ?? "");
                if (messageText.length > 0) {
                    const outgoing = JSON.stringify({
                        type: "chat",
                        payload: {
                            message: messageText,
                            sender: clientToName.get(socket) ?? "Anonymous",
                            userId: clientToUserId.get(socket) ?? "",
                            roomId,
                            timestamp: Date.now(),
                        },
                    });
                    appendToHistory(roomId, outgoing);
                    broadcastToRoom(roomId, outgoing);
                }
                return;
            }
        } catch {
            // Not JSON → fallback to chatting in current room
            if (!clientToName.has(socket)) {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "error", payload: { code: "NOT_IDENTIFIED" } }));
                }
                return;
            }
            const roomId = clientToRoomId.get(socket) || DEFAULT_ROOM_ID;
            if (text.length > 0) {
                const outgoing = JSON.stringify({
                    type: "chat",
                    payload: {
                        message: text,
                        sender: clientToName.get(socket) ?? "Anonymous",
                        roomId,
                        timestamp: Date.now(),
                    },
                });
                appendToHistory(roomId, outgoing);
                broadcastToRoom(roomId, outgoing);
            }
        }
    });
});

httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on port ${port}`);
});