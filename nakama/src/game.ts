import { MatchMove, PlayerSeat, SerializedState } from './types';

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

export function normalizeGridSize(input?: number): number {
  const n = input ?? 5;
  return Math.max(3, Math.min(8, Math.floor(n)));
}

export function edgeKey(aX: number, aY: number, bX: number, bY: number): string {
  const [p1, p2] = [[aX, aY], [bX, bY]].sort((lhs, rhs) => {
    if (lhs[0] === rhs[0]) return lhs[1] - rhs[1];
    return lhs[0] - rhs[0];
  });
  return `${p1[0]},${p1[1]}-${p2[0]},${p2[1]}`;
}

export function isAdjacentEdge(gridSize: number, key: string): boolean {
  const [a, b] = key.split('-');
  if (!a || !b) return false;
  const [x1, y1] = a.split(',').map(Number);
  const [x2, y2] = b.split(',').map(Number);
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return false;
  if ([x1, y1, x2, y2].some((n) => n < 0 || n >= gridSize)) return false;
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return dx + dy === 1;
}

export function boxKey(x: number, y: number): string {
  return `${x},${y}`;
}

function boxEdges(x: number, y: number): string[] {
  return [
    edgeKey(x, y, x + 1, y),
    edgeKey(x, y, x, y + 1),
    edgeKey(x + 1, y, x + 1, y + 1),
    edgeKey(x, y + 1, x + 1, y + 1),
  ];
}

export function boxesAffected(gridSize: number, key: string): string[] {
  const [a, b] = key.split('-');
  const [x1, y1] = a.split(',').map(Number);
  const [x2, y2] = b.split(',').map(Number);
  const result: string[] = [];
  if (x1 === x2) {
    const x = x1;
    const topY = Math.min(y1, y2);
    if (x > 0 && topY < gridSize - 1) result.push(boxKey(x - 1, topY));
    if (x < gridSize - 1 && topY < gridSize - 1) result.push(boxKey(x, topY));
  } else {
    const y = y1;
    const leftX = Math.min(x1, x2);
    if (y > 0 && leftX < gridSize - 1) result.push(boxKey(leftX, y - 1));
    if (y < gridSize - 1 && leftX < gridSize - 1) result.push(boxKey(leftX, y));
  }
  return result;
}

export function createInitialSnapshot(roomCode: string, gridSize: number, creator: { userId: string; username: string }): SerializedState {
  const now = new Date().toISOString();
  const firstPlayer: PlayerSeat = {
    userId: creator.userId,
    username: creator.username,
    color: COLORS[0],
    isConnected: true,
    joinedAt: now,
  };

  return {
    roomCode,
    gridSize,
    status: 'waiting',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    currentTurnUserId: creator.userId,
    players: [firstPlayer],
    spectators: [],
    edges: {},
    boxes: {},
    scores: { [creator.userId]: 0 },
    moveLog: [],
    winnerIds: [],
    reconnectGraceSec: 60,
  };
}

export function addPlayer(snapshot: SerializedState, userId: string, username: string): SerializedState {
  if (snapshot.players.some((p) => p.userId === userId)) {
    return {
      ...snapshot,
      players: snapshot.players.map((p) => p.userId === userId ? { ...p, isConnected: true, username } : p),
    };
  }

  const player: PlayerSeat = {
    userId,
    username,
    color: COLORS[snapshot.players.length % COLORS.length],
    isConnected: true,
    joinedAt: new Date().toISOString(),
  };
  return {
    ...snapshot,
    players: [...snapshot.players, player],
    scores: { ...snapshot.scores, [userId]: snapshot.scores[userId] ?? 0 },
    currentTurnUserId: snapshot.currentTurnUserId ?? userId,
  };
}

export function markDisconnected(snapshot: SerializedState, userId: string): SerializedState {
  return {
    ...snapshot,
    players: snapshot.players.map((p) => p.userId === userId ? { ...p, isConnected: false } : p),
    spectators: snapshot.spectators.filter((s) => s.userId !== userId),
  };
}

export function startIfReady(snapshot: SerializedState): SerializedState {
  if (snapshot.status !== 'waiting') return snapshot;
  if (snapshot.players.length < 2) return snapshot;
  return {
    ...snapshot,
    status: 'active',
    startedAt: snapshot.startedAt ?? new Date().toISOString(),
    currentTurnUserId: snapshot.currentTurnUserId ?? snapshot.players[0]?.userId ?? null,
  };
}

export function totalPossibleEdges(gridSize: number): number {
  return (gridSize - 1) * gridSize * 2;
}

function nextTurn(snapshot: SerializedState, currentUserId: string): string | null {
  if (snapshot.players.length === 0) return null;
  var idx = -1;
  for (var i = 0; i < snapshot.players.length; i += 1) {
    if (snapshot.players[i].userId === currentUserId) { idx = i; break; }
  }
  if (idx < 0) return snapshot.players[0].userId;
  return snapshot.players[(idx + 1) % snapshot.players.length].userId;
}

export function applyMove(snapshot: SerializedState, playerId: string, key: string): { snapshot: SerializedState; error?: string; completedBoxes: string[] } {
  if (snapshot.status !== 'active') return { snapshot, error: 'Game is not active.', completedBoxes: [] };
  if (snapshot.currentTurnUserId !== playerId) return { snapshot, error: 'It is not your turn.', completedBoxes: [] };
  if (!isAdjacentEdge(snapshot.gridSize, key)) return { snapshot, error: 'Invalid edge.', completedBoxes: [] };
  if (snapshot.edges[key]) return { snapshot, error: 'Edge already taken.', completedBoxes: [] };

  const newEdges = { ...snapshot.edges, [key]: playerId };
  const completedBoxes: string[] = [];
  const newBoxes = { ...snapshot.boxes };
  const newScores = { ...snapshot.scores };

  for (const candidate of boxesAffected(snapshot.gridSize, key)) {
    if (newBoxes[candidate]) continue;
    const [x, y] = candidate.split(',').map(Number);
    const complete = boxEdges(x, y).every((edge) => Boolean(newEdges[edge]));
    if (complete) {
      newBoxes[candidate] = playerId;
      newScores[playerId] = (newScores[playerId] ?? 0) + 1;
      completedBoxes.push(candidate);
    }
  }

  const turnAfterMove = completedBoxes.length > 0 ? playerId : nextTurn(snapshot, playerId);
  const move: MatchMove = {
    playerId,
    edgeKey: key,
    createdAt: new Date().toISOString(),
    completedBoxes,
    turnAfterMove,
  };

  let next: SerializedState = {
    ...snapshot,
    edges: newEdges,
    boxes: newBoxes,
    scores: newScores,
    currentTurnUserId: turnAfterMove,
    moveLog: [...snapshot.moveLog, move],
  };

  if (Object.keys(newEdges).length === totalPossibleEdges(snapshot.gridSize)) {
    var highest = -Infinity;
    for (var scoreKey in newScores) {
      if (newScores[scoreKey] > highest) highest = newScores[scoreKey];
    }
    var winnerIds: string[] = [];
    for (var userId in newScores) {
      if (newScores[userId] === highest) winnerIds.push(userId);
    }
    next = {
      ...next,
      status: 'finished',
      finishedAt: new Date().toISOString(),
      winnerIds,
      currentTurnUserId: null,
    };
  }

  return { snapshot: next, completedBoxes };
}
