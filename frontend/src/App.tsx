import { useEffect, useState, useRef } from 'react';
import './App.css';

function App() {
  type ChatItem =
    | { kind: 'chat'; message: string; sender: string; timestamp: number; roomId: string }
    | { kind: 'system'; message: string; timestamp: number; roomId: string }
    | { kind: 'raw'; raw: string };
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [currentRoom, setCurrentRoom] = useState('broadcast');
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [myName, setMyName] = useState<string>('');
  const [needsIdentity, setNeedsIdentity] = useState<boolean>(true);
  const [nameInput, setNameInput] = useState<string>('');
  const [nameError, setNameError] = useState<string>('');
  const storedNameRef = useRef<string | null>(null);
  const desiredRoomRef = useRef<string>('broadcast');
  const [memberCount, setMemberCount] = useState<number>(0);

  useEffect(() => {
    // Load stored name on first render to avoid showing modal on refresh
    const stored = localStorage.getItem('displayName');
    storedNameRef.current = stored;
    if (stored) {
      setMyName(stored);
      setNameInput(stored);
      setNeedsIdentity(false);
    }

    const url = new URL(window.location.href);
    const initialRoom = url.searchParams.get('room')?.trim() || 'broadcast';
    desiredRoomRef.current = initialRoom;
    const resolveWsUrl = (): string => {
      const envUrl = import.meta.env?.VITE_WS_URL as string | undefined;
      if (envUrl && envUrl.trim().length > 0) return envUrl.trim();
      // Fallbacks: dev -> localhost:8080, prod -> same host with ws/wss
      if (window.location.port === '5173') return 'ws://localhost:8080';
      const isHttps = window.location.protocol === 'https:';
      return `${isHttps ? 'wss' : 'ws'}://${window.location.host}`;
    };
    const ws = new WebSocket(resolveWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to server');
      setIsConnected(true);
      // Identify automatically if we have a stored name; join will happen after identity
      if (storedNameRef.current) {
        ws.send(JSON.stringify({ type: 'identify', payload: { name: storedNameRef.current } }));
      } else {
        setNeedsIdentity(true);
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (parsed?.type === 'require_identity') {
          // Auto-identify if we have a stored name; otherwise prompt
          if (storedNameRef.current) {
            wsRef.current?.send(JSON.stringify({ type: 'identify', payload: { name: storedNameRef.current } }));
          } else {
            setNeedsIdentity(true);
          }
          return;
        }
        if (parsed?.type === 'identity' && parsed?.payload?.name) {
          setMyName(String(parsed.payload.name));
          setNeedsIdentity(false);
          setNameError('');
          storedNameRef.current = String(parsed.payload.name);
          try { localStorage.setItem('displayName', storedNameRef.current); } catch (err) {
            // ignore storage errors in CI/browsers without quota
            console.debug('localStorage set displayName failed', err);
          }
          // Now that identity is set, join desired room
          const target = desiredRoomRef.current || 'broadcast';
          wsRef.current?.send(JSON.stringify({ type: 'join', payload: { roomId: target } }));
          setCurrentRoom(target);
          return;
        }
        if (parsed?.type === 'identify_error' && parsed?.payload?.code === 'NAME_TAKEN') {
          setNameError('Name is already taken');
          setNeedsIdentity(true);
          // Clear stored name if it conflicts to avoid loops
          storedNameRef.current = null;
          try { localStorage.removeItem('displayName'); } catch (err) {
            console.debug('localStorage remove displayName failed', err);
          }
          return;
        }
        if (parsed?.type === 'error' && parsed?.payload?.code === 'NOT_IDENTIFIED') {
          setNeedsIdentity(true);
          return;
        }
        if (parsed?.type === 'chat' && parsed?.payload) {
          const { message, sender, timestamp, roomId } = parsed.payload;
          setMessages((m) => [...m, { kind: 'chat', message: String(message), sender: String(sender), timestamp: Number(timestamp), roomId: String(roomId) }]);
          return;
        }
        if (parsed?.type === 'system' && parsed?.payload) {
          const { message, timestamp, roomId } = parsed.payload;
          setMessages((m) => [...m, { kind: 'system', message: String(message), timestamp: Number(timestamp), roomId: String(roomId) }]);
          return;
        }
        if (parsed?.type === 'room_state' && parsed?.payload) {
          const { memberCount } = parsed.payload;
          setMemberCount(Number(memberCount) || 0);
          return;
        }
      } catch {
        // fallback raw
        setMessages((m) => [...m, { kind: 'raw', raw: String(event.data) }]);
        return;
      }
      // unknown message shape -> ignore
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
      setIsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Persist only your own view per-room; not shared across users
  useEffect(() => {
    // Load per-room local view on room change
    const saved = localStorage.getItem(`room:${currentRoom}:messages`);
    if (saved) {
      try {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) setMessages(arr);
      } catch {
        // ignore
      }
    } else {
      setMessages([]);
    }
  }, [currentRoom]);

  useEffect(() => {
    // Save per-room local view whenever messages change
    try {
      localStorage.setItem(`room:${currentRoom}:messages`, JSON.stringify(messages));
    } catch {
      // ignore quota errors
    }
  }, [messages, currentRoom]);

  const sendMessage = () => {
    if (input.trim() !== '' && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat', payload: { message: input } }));
      setInput('');
    }
  };

  const submitIdentity = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const trimmed = nameInput.trim();
    if (trimmed.length === 0) {
      setNameError('Please enter a name');
      return;
    }
    wsRef.current.send(JSON.stringify({ type: 'identify', payload: { name: trimmed } }));
    // Do not set local state here; wait for server confirmation (identity event)
  };

  const joinRoom = () => {
    const target = roomInput.trim() || 'broadcast';
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join', payload: { roomId: target } }));
      setCurrentRoom(target);
      setMessages([]);
      const next = new URL(window.location.href);
      next.searchParams.set('room', target);
      window.history.replaceState(null, '', next.toString());
    }
  };

  const copyInviteLink = async () => {
    try {
      const link = new URL(window.location.href);
      link.searchParams.set('room', currentRoom);
      await navigator.clipboard.writeText(link.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy invite link', err);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-black text-white">
      <div className="mx-auto max-w-2xl h-screen flex flex-col">
        {/* Header */}
        <div className="p-4 bg-gray-900/60 backdrop-blur border-b border-white/10">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">
              <img src="/logo.png" alt="Den Den Mushi Logo" className="inline-block w-8 h-8 mr-1" />
              <span className="bg-gradient-to-r from-fuchsia-400 to-purple-400 bg-clip-text text-transparent">Chatter</span>
              <span className="ml-2 text-xs text-gray-400">roomed chat</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Room</span>
              <span className="px-2 py-1 rounded-lg bg-gray-800/70 border border-white/10 text-sm">{currentRoom}</span>
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
              <span className="text-xs text-gray-400">{memberCount} online</span>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') joinRoom(); }}
              className="flex-1 max-w-xs px-3 py-2 rounded-lg text-white placeholder-gray-400 bg-transparent border border-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500"
              placeholder="Enter room id (e.g. general)"
            />
            <button
              onClick={joinRoom}
              className="px-4 py-2 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 transition"
            >
              Join
            </button>
            <button
              onClick={copyInviteLink}
              className="px-4 py-2 rounded-lg font-medium text-white bg-gray-800 border border-gray-700 hover:bg-gray-700 transition"
            >
              {copied ? 'Copied!' : 'Copy invite link'}
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-sm text-gray-400 mt-24">
              No messages yet. Say hello to the room!
            </div>
          )}
          {messages.map((item, idx) => {
            if (item.kind === 'system') {
              return (
                <div key={idx} className="flex justify-center">
                  <div className="text-xs text-gray-400 bg-gray-800/40 px-3 py-1 rounded-full">
                    {item.message}
                  </div>
                </div>
              );
            }
            if (item.kind === 'chat') {
              const isMine = item.sender === myName;
              const bubbleClass = isMine
                ? 'bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white ml-auto'
                : 'bg-gray-800/70 border border-white/10 text-white';
              const containerClass = isMine ? 'flex justify-end' : 'flex justify-start';
              return (
                <div key={idx} className={containerClass}>
                  <div className={`inline-block max-w-[80%] rounded-2xl px-4 py-2 shadow-lg shadow-black/30 ${bubbleClass}`}>
                    {!isMine && (
                      <div className="text-xs text-gray-200/80 mb-1">{item.sender}</div>
                    )}
                    <div className="whitespace-pre-wrap leading-relaxed">{item.message}</div>
                    <div className="text-[10px] text-white/70 mt-1">{new Date(item.timestamp).toLocaleTimeString()}</div>
                  </div>
                </div>
              );
            }
            return (
              <div key={idx} className="flex justify-center">
                <span className="text-xs text-gray-500">{item.raw}</span>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <div className="p-3 bg-gray-900/60 backdrop-blur border-t border-white/10">
          <div className="flex items-center gap-2 bg-white/90 rounded-xl p-1 shadow-lg">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }}
              className="flex-1 px-4 py-3 rounded-lg bg-transparent text-gray-900 placeholder-gray-500 focus:outline-none"
              placeholder="Type your message..."
            />
            <button
              onClick={sendMessage}
              className="px-5 py-2.5 rounded-lg font-medium text-white bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 active:from-purple-700 active:to-fuchsia-700 transition"
            >
              Send
            </button>
          </div>
          {!needsIdentity && (
            <div className="mt-2 text-xs text-gray-400">Signed in as: <span className="text-gray-300 font-medium">{myName || '...'}</span></div>
          )}
        </div>

        {needsIdentity && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="w-full max-w-sm bg-gray-900 border border-white/10 rounded-xl p-5">
              <div className="text-lg font-semibold mb-1">Choose a name</div>
              <div className="text-sm text-gray-400 mb-4">Pick a unique display name before joining any room.</div>
              <input
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitIdentity(); }}
                className="w-full px-3 py-2 rounded-lg text-white placeholder-gray-400 bg-transparent border border-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500"
                placeholder="e.g. raman"
              />
              {nameError && <div className="mt-1 text-xs text-red-400">{nameError}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={submitIdentity}
                  className="px-4 py-2 rounded-lg font-medium text-white bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
