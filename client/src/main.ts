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

let session: Session;
let socket: Socket;
let currentMatchId: string | null = null;
let snapshot: Snapshot | null = null;
let currentUserId: string | null = null;
let isSpectator = false;
const logLines: string[] = [];

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="app">
    <h1>Dots and Boxes</h1>
    <div class="panel">
      <div class="row">
        <input id="username" placeholder="Username" maxlength="24" />
        <select id="gridSize">
          <option value="5" selected>5x5 dots</option>
          <option value="4">4x4 dots</option>
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
  const result = await client.rpc(session, id, JSON.stringify(body));
  return JSON.parse(result.payload) as T;
}

async function connect() {
  const username = getUsername();
  session = await client.authenticateDevice(getDeviceId(), true, username);
  currentUserId = session.user_id;
  socket = client.createSocket(useSSL, false);
  await socket.connect(session, true);
  socket.onmatchdata = (message: any) => {
    const raw = typeof message.data === 'string' ? message.data : message.state;
    if (message.op_code === OpCode.STATE || message.opCode === OpCode.STATE) {
      const parsed = JSON.parse(raw);
      snapshot = parsed.snapshot;
      currentMatchId = parsed.matchId;
      render();
    } else if (message.op_code === OpCode.EVENT || message.opCode === OpCode.EVENT) {
      const event = JSON.parse(raw);
      log(`${event.type}: ${JSON.stringify(event.data)}`);
    } else if (message.op_code === OpCode.ERROR || message.opCode === OpCode.ERROR) {
      const event = JSON.parse(raw);
      log(`Error: ${event.data?.reason || raw}`);
    }
  };
  socket.ondisconnect = () => {
    authState.textContent = 'Socket disconnected';
    log('Socket disconnected. Reconnect and rejoin the room to resume.');
  };

  authState.textContent = `Connected as ${username}`;
  createBtn.disabled = false;
  joinBtn.disabled = false;
  spectateBtn.disabled = false;
  refreshHistoryBtn.disabled = false;
  log('Authenticated and socket connected.');
}

async function createRoom() {
  const result = await rpc<{ roomCode: string; matchId: string; snapshot: Snapshot }>('create_room', {
    username: getUsername(),
    gridSize: Number(gridSizeInput.value),
  });
  roomCodeInput.value = result.roomCode;
  await joinRoom(false);
}

async function joinRoom(spectator: boolean) {
  const roomCode = roomCodeInput.value.trim().toUpperCase();
  if (!roomCode) return;
  const result = await rpc<{ roomCode: string; matchId: string; snapshot: Snapshot }>('join_room', {
    roomCode,
    username: getUsername(),
    spectator,
  });
  isSpectator = spectator;
  currentMatchId = result.matchId;
  snapshot = result.snapshot;
  await socket.joinMatch(result.matchId);
  log(`${spectator ? 'Spectating' : 'Joined'} room ${roomCode}.`);
  render();
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
  if (!socket || !currentMatchId || !snapshot || isSpectator) return;
  await socket.sendMatchState(currentMatchId, OpCode.MOVE, JSON.stringify({ edgeKey: key }));
}

function playerName(userId: string) {
  return snapshot?.players.find((p) => p.userId === userId)?.username || userId;
}

function colorFor(userId?: string | null) {
  return snapshot?.players.find((p) => p.userId === userId)?.color || '#64748b';
}

function renderBoard() {
  if (!snapshot) {
    boardMount.innerHTML = '<div class="small">Join a room to see the board.</div>';
    return;
  }

  const n = snapshot.gridSize - 1;
  const cells: string[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const top = edgeKey(x, y, x + 1, y);
      const left = edgeKey(x, y, x, y + 1);
      const bottom = edgeKey(x, y + 1, x + 1, y + 1);
      const right = edgeKey(x + 1, y, x + 1, y + 1);
      const boxOwner = snapshot.boxes[`${x},${y}`];
      const parts = [
        ['t', top],
        ['l', left],
        ['b', bottom],
        ['r', right],
      ].map(([cls, key]) => {
        const owner = snapshot!.edges[key];
        const style = owner ? `style="background:${colorFor(owner)}"` : '';
        const disabled = Boolean(owner) || snapshot!.status !== 'active' || snapshot!.currentTurnUserId !== currentUserId || isSpectator;
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
  boardMount.querySelectorAll<HTMLButtonElement>('[data-edge]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.edge;
      if (key) sendMove(key).catch((err) => log(String(err)));
    });
  });
}

function render() {
  if (!snapshot) {
    roomSummary.textContent = 'No room joined yet.';
    scores.innerHTML = '';
    renderBoard();
    return;
  }

  roomSummary.innerHTML = `
    <div class="row">
      <span class="badge">Room ${snapshot.roomCode}</span>
      <span class="badge">Status: ${snapshot.status}</span>
      <span class="badge">${isSpectator ? 'Spectator' : 'Player'}</span>
      <span class="badge">Turn: ${snapshot.currentTurnUserId ? playerName(snapshot.currentTurnUserId) : '—'}</span>
    </div>
    <p class="small">Players connected: ${snapshot.players.filter((p) => p.isConnected).length}/${snapshot.players.length}. Spectators: ${snapshot.spectators.length}.</p>
  `;

  scores.innerHTML = snapshot.players.map((player) => `
    <div class="score-card">
      <div><strong style="color:${player.color}">${player.username}</strong></div>
      <div>Score: ${snapshot!.scores[player.userId] ?? 0}</div>
      <div class="small">${player.isConnected ? 'Connected' : 'Disconnected'}</div>
    </div>
  `).join('');

  if (snapshot.status === 'finished') {
    const winners = snapshot.winnerIds.map((id) => playerName(id)).join(', ');
    log(`Game finished. Winner${snapshot.winnerIds.length > 1 ? 's' : ''}: ${winners}`);
  }

  renderBoard();
}

connectBtn.addEventListener('click', () => connect().catch((err) => log(`Connect failed: ${String(err)}`)));
createBtn.addEventListener('click', () => createRoom().catch((err) => log(`Create failed: ${String(err)}`)));
joinBtn.addEventListener('click', () => joinRoom(false).catch((err) => log(`Join failed: ${String(err)}`)));
spectateBtn.addEventListener('click', () => joinRoom(true).catch((err) => log(`Spectate failed: ${String(err)}`)));
refreshHistoryBtn.addEventListener('click', () => refreshHistory().catch((err) => log(`History failed: ${String(err)}`)));
render();
