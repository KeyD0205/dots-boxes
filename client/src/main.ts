import './style.css';
import { Client, Session, Socket } from '@heroiclabs/nakama-js';

type PlayerSeat = {
  userId: string;
  username: string;
  color: string;
  isConnected: boolean;
  joinedAt: string;
};

type Snapshot = {
  roomCode: string;
  gridSize: number;
  status: 'waiting' | 'active' | 'finished';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentTurnUserId: string | null;
  players: PlayerSeat[];
  spectators: Array<{ userId: string; username: string }>;
  edges: Record<string, string>;
  boxes: Record<string, string>;
  scores: Record<string, number>;
  moveLog: Array<{ playerId: string; edgeKey: string; completedBoxes: string[] }>;
  winnerIds: string[];
  reconnectGraceSec: number;
};

type HistoryEntry = {
  roomCode: string;
  gridSize: number;
  finishedAt: string;
  moves: number;
  durationSec: number;
  scores: Record<string, number>;
  winnerIds: string[];
  players: Array<{ userId: string; username: string; color: string }>;
};

const OpCode = { STATE: 101, MOVE: 102, ERROR: 103, EVENT: 104 };
const host = import.meta.env.VITE_NAKAMA_HOST || window.location.hostname;
const port = Number(import.meta.env.VITE_NAKAMA_PORT || '7350');
const useSSL = (import.meta.env.VITE_NAKAMA_SCHEME || 'http') === 'https';
const serverKey = import.meta.env.VITE_NAKAMA_SERVER_KEY || 'defaultkey';

const client = new Client(serverKey, host, port, useSSL, 3000);
client.ssl = useSSL;

// Centralized state management
const state = {
  session: null as Session | null,
  socket: null as Socket | null,
  currentMatchId: null as string | null,
  snapshot: null as Snapshot | null,
  currentUserId: null as string | null,
  isSpectator: false,
  isConnecting: false,
  isConnected: false,
};

// --- Session Persistence ---
const SESSION_KEY = 'nakamaSession';

function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: session.token, refresh_token: session.refresh_token }));
}

function loadSession(): Session | null {
  const str = localStorage.getItem(SESSION_KEY);
  if (!str) return null;
  try {
    const obj = JSON.parse(str);
    if (obj && obj.token) {
      const session = Session.restore(obj.token, obj.refresh_token);
      if (!session.isexpired(Date.now() / 1000)) {
        return session;
      }
    }
  } catch {}
  clearSession();
  return null;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

const logLines: string[] = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="app">
    <h1>Dots and Boxes</h1>
    <div class="panel">
      <div class="row">
        <input id="username" placeholder="Username" maxlength="24" />
        <select id="gridSize">
          <option value="4" selected>4x4 dots</option>
          <option value="5">5x5 dots</option>
          <option value="6">6x6 dots</option>
          <option value="7">7x7 dots</option>
        </select>
        <button id="connectBtn">Connect</button>
        <span id="authState" class="badge">Disconnected</span>
      </div>
    </div>

    <div class="panel">
      <div class="row">
        <button id="createBtn" disabled>Create Room</button>
        <input id="roomCode" placeholder="Room code" maxlength="6" />
        <button id="joinBtn" disabled>Join Room</button>
        <button id="spectateBtn" class="secondary" disabled>Spectate</button>
        <button id="refreshHistoryBtn" class="secondary" disabled>Refresh History</button>
      </div>
      <p class="small">Create a room, then open the app in a second browser tab or window to join the same room code.</p>
    </div>

    <div class="panel">
      <div id="roomSummary">No room joined yet.</div>
    </div>

    <div class="panel">
      <div class="scores" id="scores"></div>
    </div>

    <div class="panel grid-wrap">
      <div id="boardMount"></div>
    </div>

    <div class="panel">
      <h3>Event Log</h3>
      <div class="log" id="log"></div>
    </div>

    <div class="panel">
      <h3>Recent Match History</h3>
      <div id="history"></div>
    </div>
  </div>
`;

const usernameInput = document.querySelector<HTMLInputElement>('#username')!;
const gridSizeInput = document.querySelector<HTMLSelectElement>('#gridSize')!;
const connectBtn = document.querySelector<HTMLButtonElement>('#connectBtn')!;
const createBtn = document.querySelector<HTMLButtonElement>('#createBtn')!;
const joinBtn = document.querySelector<HTMLButtonElement>('#joinBtn')!;
const spectateBtn = document.querySelector<HTMLButtonElement>('#spectateBtn')!;
const refreshHistoryBtn = document.querySelector<HTMLButtonElement>('#refreshHistoryBtn')!;
const roomCodeInput = document.querySelector<HTMLInputElement>('#roomCode')!;
const authState = document.querySelector<HTMLSpanElement>('#authState')!;
const roomSummary = document.querySelector<HTMLDivElement>('#roomSummary')!;
const scores = document.querySelector<HTMLDivElement>('#scores')!;
const boardMount = document.querySelector<HTMLDivElement>('#boardMount')!;
const logEl = document.querySelector<HTMLDivElement>('#log')!;
const historyEl = document.querySelector<HTMLDivElement>('#history')!;

function log(message: string) {
  logLines.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  logEl.textContent = logLines.slice(0, 60).join('\n');
}

function extractErrorMessage(err: any): string {
  // Handle Response objects from Nakama client
  if (err instanceof Response) {
    return `HTTP ${err.status}: ${err.statusText}`;
  }
  // Handle error objects
  if (err instanceof Error) {
    return err.message;
  }
  // Handle objects with message property
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String(err.message);
  }
  // Fallback
  return String(err);
}

function showErrorNotification(message: string) {
  const notification = document.createElement('div');
  notification.className = 'notification error';
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 4000);
}

function validateRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code);
}

function validateUsername(username: string): boolean {
  return username.length > 0 && username.length <= 24;
}

function addErrorHandler(fn: () => Promise<void>, label: string) {
  return () => {
    fn().catch((err) => {
      const msg = `${label} failed: ${extractErrorMessage(err)}`;
      log(msg);
      showErrorNotification(msg);
    });
  };
}

function getDeviceId() {
  const key = 'dots_boxes_device_id';
  let existing = localStorage.getItem(key);
  if (!existing) {
    existing = `${crypto.randomUUID()}-${Date.now()}`;
    localStorage.setItem(key, existing);
  }
  return existing;
}

function getUsername() {
  return usernameInput.value.trim() || `Player-${getDeviceId().slice(0, 6)}`;
}

async function rpc<T>(id: string, body: unknown): Promise<T> {
  if (!state.session) throw new Error('Not authenticated');
  
  try {
    const result = await client.rpc(state.session, id, JSON.stringify(body));
    log(`RPC ${id} response: payload type = ${typeof result.payload}`);
    
    // Handle both string and object payloads
    if (typeof result.payload === 'string') {
      return JSON.parse(result.payload) as T;
    } else if (typeof result.payload === 'object' && result.payload !== null) {
      return result.payload as T;
    } else {
      throw new Error(`Invalid RPC response: ${String(result.payload)}`);
    }
  } catch (err) {
    log(`RPC ${id} error: ${extractErrorMessage(err)}`);
    throw err;
  }
}

async function disconnect() {
  state.socket?.disconnect(true);
  state.session = null;
  state.snapshot = null;
  state.currentMatchId = null;
  state.isConnected = false;
  state.isSpectator = false;
  clearSessionToken();
}

function setupSocketHandlers() {
  if (!state.socket) return;

  state.socket.onmatchdata = (message: any) => {
    try {
      const opCode = message.op_code ?? message.opCode;
      const raw = typeof message.data === 'string' ? message.data : message.state;

      if (!opCode || !raw) {
        log('Invalid message format');
        return;
      }

      if (opCode === OpCode.STATE) {
        const parsed = JSON.parse(raw);
        state.snapshot = parsed.snapshot;
        state.currentMatchId = parsed.matchId;
        render();
      } else if (opCode === OpCode.EVENT) {
        const event = JSON.parse(raw);
        log(`${event.type}: ${JSON.stringify(event.data)}`);
      } else if (opCode === OpCode.ERROR) {
        const event = JSON.parse(raw);
        log(`Error: ${event.data?.reason || raw}`);
      }
    } catch (err) {
      log(`Message parse error: ${String(err)}`);
    }
  };

  state.socket.ondisconnect = async () => {
    state.isConnected = false;
    authState.textContent = 'Reconnecting...';
    log('Socket disconnected. Attempting to reconnect...');
    
    await new Promise(r => setTimeout(r, 2000));
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      try {
        await connect();
        reconnectAttempts = 0;
        if (state.currentMatchId) {
          await state.socket!.joinMatch(state.currentMatchId);
          log('Rejoined match after reconnect.');
        }
      } catch (err) {
        log(`Reconnect attempt ${reconnectAttempts} failed: ${extractErrorMessage(err)}`);
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          authState.textContent = 'Reconnection failed';
          showErrorNotification('Connection lost. Please refresh the page.');
        }
      }
    }
  };
}

async function connect() {
  if (state.isConnecting) return;
  state.isConnecting = true;

  try {
    const username = getUsername();
    if (!validateUsername(username)) {
      throw new Error('Invalid username');
    }


    // Try to restore session from localStorage
    let session: Session | null = loadSession();
    if (!session) {
      session = await client.authenticateDevice(getDeviceId(), true, username);
      saveSession(session);
    }

    state.session = session;
    state.currentUserId = session.user_id;
    state.socket = client.createSocket(useSSL, false);
    await state.socket.connect(session, true);

    setupSocketHandlers();

    state.isConnected = true;
    state.isConnecting = false;
    authState.textContent = `Connected as ${username}`;
    createBtn.disabled = false;
    joinBtn.disabled = false;
    spectateBtn.disabled = false;
    refreshHistoryBtn.disabled = false;
    log('Authenticated and socket connected.');
  } catch (err) {
    state.isConnecting = false;
    throw err;
  }
}

async function createRoom() {
  if (!state.isConnected) {
    showErrorNotification('Not connected. Please connect first.');
    return;
  }

  log('Creating room...');
  const result = await rpc<{ roomCode: string; matchId: string; snapshot: Snapshot }>('create_room', {
    username: getUsername(),
    gridSize: Number(gridSizeInput.value),
  });

  log(`Create room response: roomCode="${result.roomCode}" (length: ${result.roomCode.length})`);
  roomCodeInput.value = result.roomCode;

  // Now, call joinRoomWithCode as a player (not spectator)
  await joinRoomWithCode(result.roomCode, false);
}

async function joinRoomWithCode(roomCode: string, spectator: boolean) {
  log(`joinRoomWithCode: roomCode="${roomCode}" (length: ${roomCode.length})`);
  
  if (!validateRoomCode(roomCode)) {
    showErrorNotification('Invalid room code. Must be 6 alphanumeric characters (e.g., ABC123).');
    return;
  }
  
  const result = await rpc<{ roomCode: string; matchId: string; snapshot: Snapshot }>('join_room', {
    roomCode,
    username: getUsername(),
    spectator,
  });
  state.isSpectator = spectator;
  state.currentMatchId = result.matchId;
  state.snapshot = result.snapshot;
  try {
    await state.socket!.joinMatch(result.matchId);
    log(`[joinMatch] Successfully joined match: ${result.matchId}`);
  } catch (err) {
    log(`[joinMatch] Failed to join match: ${extractErrorMessage(err)}`);
    showErrorNotification('Failed to join match. Please refresh and try again.');
    return;
  }
  log(`${spectator ? 'Spectating' : 'Joined'} room ${roomCode}.`);
  render();
}

async function joinRoom(spectator: boolean) {
  if (!state.isConnected) {
    showErrorNotification('Not connected. Please connect first.');
    return;
  }
  
  const roomCode = roomCodeInput.value.trim().toUpperCase();
  log(`joinRoom: roomCode input = "${roomCode}" (length: ${roomCode.length})`);
  
  await joinRoomWithCode(roomCode, spectator);
}

async function refreshHistory() {
  const result = await rpc<{ items: HistoryEntry[] }>('list_history', {});
  const items = result.items || [];
  historyEl.innerHTML = items.length === 0
    ? '<div class="small">No completed matches yet.</div>'
    : items.slice().reverse().map((entry) => `
      <div class="history-item">
        <div><strong>${entry.roomCode}</strong> · ${entry.gridSize}x${entry.gridSize} dots · ${entry.moves} moves</div>
        <div class="small">Finished ${new Date(entry.finishedAt).toLocaleString()} · Duration ${entry.durationSec}s</div>
        <div class="small">Winners: ${entry.winnerIds.map((id) => entry.players.find((p) => p.userId === id)?.username || id).join(', ') || 'Draw'}</div>
      </div>
    `).join('');
}

function edgeKey(aX: number, aY: number, bX: number, bY: number): string {
  const [p1, p2] = [[aX, aY], [bX, bY]].sort((lhs, rhs) => lhs[0] === rhs[0] ? lhs[1] - rhs[1] : lhs[0] - rhs[0]);
  return `${p1[0]},${p1[1]}-${p2[0]},${p2[1]}`;
}

async function sendMove(key: string) {
  if (!state.socket || !state.currentMatchId || !state.snapshot || state.isSpectator) return;
  await state.socket.sendMatchState(state.currentMatchId, OpCode.MOVE, JSON.stringify({ edgeKey: key }));
}

function playerName(userId: string) {
  return state.snapshot?.players.find((p) => p.userId === userId)?.username || userId;
}

function colorFor(userId?: string | null) {
  return state.snapshot?.players.find((p) => p.userId === userId)?.color || '#64748b';
}

function handleBoardClick(e: Event) {
  const btn = (e.target as HTMLElement).closest('[data-edge]');
  if (btn?.dataset.edge) {
    sendMove(btn.dataset.edge).catch((err) => log(String(err)));
  }
}

function renderBoard() {
  // Remove old event listener
  boardMount.removeEventListener('click', handleBoardClick);

  if (!state.snapshot) {
    boardMount.innerHTML = '<div class="small">Join a room to see the board.</div>';
    return;
  }

  const n = state.snapshot.gridSize - 1;
  const cells: string[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const top = edgeKey(x, y, x + 1, y);
      const left = edgeKey(x, y, x, y + 1);
      const bottom = edgeKey(x, y + 1, x + 1, y + 1);
      const right = edgeKey(x + 1, y, x + 1, y + 1);
      const boxOwner = state.snapshot.boxes[`${x},${y}`];
      const parts = [
        ['t', top],
        ['l', left],
        ['b', bottom],
        ['r', right],
      ].map(([cls, key]) => {
        const owner = state.snapshot!.edges[key];
        const style = owner ? `style="background:${colorFor(owner)}"` : '';
        const disabled = Boolean(owner) || state.snapshot!.status !== 'active' || state.snapshot!.currentTurnUserId !== state.currentUserId || state.isSpectator;
        return `<button class="edge ${cls}" data-edge="${key}" ${style} ${disabled ? 'disabled' : ''}></button>`;
      }).join('');

      cells.push(`
        <div class="cell">
          ${parts}
          ${boxOwner ? `<div class="box" style="background:${colorFor(boxOwner)}">${playerName(boxOwner).slice(0, 1).toUpperCase()}</div>` : ''}
          <span class="dot tl"></span><span class="dot tr"></span><span class="dot bl"></span><span class="dot br"></span>
        </div>
      `);
    }
  }

  boardMount.innerHTML = `<div class="board" style="grid-template-columns: repeat(${n}, 56px)">${cells.join('')}</div>`;
  
  // Add single delegated event listener
  boardMount.addEventListener('click', handleBoardClick);
}

function render() {
  if (!state.snapshot) {
    roomSummary.textContent = 'No room joined yet.';
    scores.innerHTML = '';
    renderBoard();
    return;
  }

  roomSummary.innerHTML = `
    <div class="row">
      <span class="badge">Room ${state.snapshot.roomCode}</span>
      <span class="badge">Status: ${state.snapshot.status}</span>
      <span class="badge">${state.isSpectator ? 'Spectator' : 'Player'}</span>
      <span class="badge">Turn: ${state.snapshot.currentTurnUserId ? playerName(state.snapshot.currentTurnUserId) : '—'}</span>
    </div>
    <p class="small">Players connected: ${state.snapshot.players.filter((p) => p.isConnected).length}/${state.snapshot.players.length}. Spectators: ${state.snapshot.spectators.length}.</p>
  `;

  scores.innerHTML = state.snapshot.players.map((player) => `
    <div class="score-card">
      <div><strong style="color:${player.color}">${player.username}</strong></div>
      <div>Score: ${state.snapshot!.scores[player.userId] ?? 0}</div>
      <div class="small">${player.isConnected ? 'Connected' : 'Disconnected'}</div>
    </div>
  `).join('');

  if (state.snapshot.status === 'finished') {
    const winners = state.snapshot.winnerIds.map((id) => playerName(id)).join(', ');
    log(`Game finished. Winner${state.snapshot.winnerIds.length > 1 ? 's' : ''}: ${winners}`);
  }

  renderBoard();
}

connectBtn.addEventListener('click', addErrorHandler(connect, 'Connect'));
createBtn.addEventListener('click', addErrorHandler(createRoom, 'Create room'));
joinBtn.addEventListener('click', addErrorHandler(() => joinRoom(false), 'Join room'));
spectateBtn.addEventListener('click', addErrorHandler(() => joinRoom(true), 'Spectate'));
refreshHistoryBtn.addEventListener('click', addErrorHandler(refreshHistory, 'Refresh history'));

// --- Auto-connect on page load if session token exists ---
if (loadSessionToken()) {
  connect().catch((err) => {
    log('Auto-connect failed: ' + extractErrorMessage(err));
    clearSession();
  });
}

render();
