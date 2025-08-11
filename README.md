chat-app

A minimal real-time room-based chat app.

- Frontend: React + Vite + TypeScript (port 5173)
- Backend: Node.js + ws WebSocket server (port 8080)

Features

- Identity (Sign in as)
  - Required before joining rooms or sending messages
  - Name must be unique (case-insensitive) across connected users
  - Name is stored locally so refreshes don’t prompt again
- Rooms
  - Default room: broadcast
  - Join any room by ID; switch rooms anytime
  - Shareable invite links: ?room=<roomId> (Copy Invite Link in UI)
- Messaging
  - Distinct styling for your messages vs others
  - System notices on join/leave
  - Live member count updates (available via room_state)
- History
  - Server: in-memory per-room history only supports your own reload persistence; it is NOT sent to new joiners
  - Client: per-room view persisted in localStorage (your browser only)

Prerequisites

- Node.js 18+ (recommended 20+)
- npm 9+

Getting started (local)

1) Install dependencies

```bash
# Backend
cd backend
npm i

# Frontend
cd ../frontend
npm i
```

2) Run the apps (two terminals)

```bash
# Terminal 1 — backend (WebSocket server on ws://localhost:8080)
cd backend
npm run dev

# Terminal 2 — frontend (Vite dev server on http://localhost:5173)
cd frontend
npm run dev
```

3) Open the app

- Visit http://localhost:5173
- Choose a unique name in the modal (stored locally, won’t prompt on refresh)
- Join or create a room, or share the invite link

Production build

```bash
# Backend build
cd backend
npm run build
npm run start   # runs dist/index.js

# Frontend build
cd ../frontend
npm run build   # outputs to dist/
```

You can serve the frontend dist/ with any static host and keep the backend running on port 8080.

Project structure

```
chat-app/
  backend/
    src/index.ts        # WebSocket server
    tsconfig.json
    package.json
  frontend/
    src/App.tsx         # UI & client protocol handling
    src/main.tsx
    vite.config.ts
    package.json
```

Protocol (WebSocket JSON)

Client -> Server

- identify

```json
{ "type": "identify", "payload": { "name": "Alice" } }
```

- join

```json
{ "type": "join", "payload": { "roomId": "general" } }
```

- chat

```json
{ "type": "chat", "payload": { "message": "Hello" } }
```

Server -> Client

- require_identity

```json
{ "type": "require_identity" }
```

- identity (confirmation)

```json
{ "type": "identity", "payload": { "name": "Alice" } }
```

- identify_error (name taken)

```json
{ "type": "identify_error", "payload": { "code": "NAME_TAKEN" } }
```

- error (not identified)

```json
{ "type": "error", "payload": { "code": "NOT_IDENTIFIED" } }
```

- chat

```json
{
  "type": "chat",
  "payload": {
    "message": "Hello",
    "sender": "Alice",
    "roomId": "general",
    "timestamp": 1710000000000
  }
}
```

- system (join/leave notice)

```json
{
  "type": "system",
  "payload": {
    "message": "Alice joined",
    "roomId": "general",
    "timestamp": 1710000000000
  }
}
```

- room_state (member count)

```json
{ "type": "room_state", "payload": { "roomId": "general", "memberCount": 3 } }
```

Configuration

- Ports
  - Backend WebSocket: 8080 (see backend/src/index.ts)
  - Frontend dev: 5173 (Vite default)
- To change ports, update the code or dev server config accordingly.

Troubleshooting

- Port in use (EADDRINUSE 8080)

```bash
# macOS/Linux
lsof -ti tcp:8080 | xargs -r kill -9
```

- Can’t connect to WebSocket
  - Ensure backend is running and accessible at ws://localhost:8080
  - Check browser console/network tab

- Name prompt keeps appearing on refresh
  - Name is stored in localStorage under displayName
  - If a duplicate exists on the server, you will be asked to choose another

Notes & limitations

- In-memory data (names, room membership, history) resets when the backend restarts
- No authentication; display name only
- History is not shared with new joiners by design

Next steps (ideas)

- Persistent database (SQLite/Postgres) for durable messages
- Typing indicators and read receipts
- Better moderation/ownership per room
- Deploy scripts and containerization

Repository hygiene

- CI: GitHub Actions at `.github/workflows/ci.yml` builds backend and frontend and runs lints on PRs
- EditorConfig: `.editorconfig` enforces consistent formatting
- PR template: `.github/PULL_REQUEST_TEMPLATE.md` for consistent reviews


