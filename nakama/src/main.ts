import { addPlayer, applyMove, createInitialSnapshot, markDisconnected, normalizeGridSize, startIfReady } from './game';
import { buildHistory, buildRoomRecord, readRoom, writeHistory, writeRoom } from './storage';
import { CreateRoomPayload, JoinRoomPayload, MatchState, OpCode, PresenceRef, SerializedState } from './types';

declare const console: any;

function json<T>(payload: string): T {
  return payload ? JSON.parse(payload) as T : {} as T;
}

function serialize(state: MatchState): SerializedState {
  return {
    roomCode: state.roomCode,
    gridSize: state.gridSize,
    status: state.status,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    currentTurnUserId: state.currentTurnUserId,
    players: state.players,
    spectators: state.spectators,
    edges: state.edges,
    boxes: state.boxes,
    scores: state.scores,
    moveLog: state.moveLog,
    winnerIds: state.winnerIds,
    reconnectGraceSec: state.reconnectGraceSec,
  };
}

function eventPayload(type: string, data: Record<string, unknown>) {
  return JSON.stringify({ type, data, at: new Date().toISOString() });
}

function statePayload(state: MatchState) {
  return JSON.stringify({
    roomCode: state.roomCode,
    matchId: state.matchId,
    snapshot: serialize(state),
  });
}

function randomRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function ensureRuntimeMatch(nk: nkruntime.Nakama, logger: nkruntime.Logger, roomCode: string): { room: any; matchId: string } {
  const room = readRoom(nk, roomCode);
  if (!room) {
    throw new Error('Room not found.');
  }

  let validMatch = true;
  try {
    nk.matchGet(room.matchId);
  } catch (_err) {
    validMatch = false;
  }

  if (validMatch) return { room, matchId: room.matchId };

  const recreatedMatchId = nk.matchCreate('dots_boxes', { roomCode, snapshot: room.snapshot });
  const updated = { ...room, matchId: recreatedMatchId, updatedAt: new Date().toISOString() };
  writeRoom(nk, updated);
  logger.info('Recovered room %s into new match %s', roomCode, recreatedMatchId);
  return { room: updated, matchId: recreatedMatchId };
}

const createRoomRpc: nkruntime.RpcFunction = function (ctx, logger, nk, payload) {
  const body = json<CreateRoomPayload>(payload);
  if (!ctx.userId) throw new Error('Authentication required.');
  const username = body.username?.trim() || ctx.username || `Player-${ctx.userId.slice(0, 6)}`;
  const gridSize = normalizeGridSize(body.gridSize);

  let roomCode = randomRoomCode();
  while (readRoom(nk, roomCode)) roomCode = randomRoomCode();

  const snapshot = createInitialSnapshot(roomCode, gridSize, { userId: ctx.userId, username });
  const matchId = nk.matchCreate('dots_boxes', { roomCode, snapshot });
  const room = buildRoomRecord(snapshot, matchId, ctx.userId);
  writeRoom(nk, room);
  logger.info('Created room %s match %s', roomCode, matchId);

  return JSON.stringify({ roomCode, matchId, snapshot });
};

const joinRoomRpc: nkruntime.RpcFunction = function (ctx, logger, nk, payload) {
  const body = json<JoinRoomPayload>(payload);
  if (!ctx.userId) throw new Error('Authentication required.');
  const roomCode = body.roomCode?.trim().toUpperCase();
  if (!roomCode) throw new Error('roomCode is required.');
  const { room, matchId } = ensureRuntimeMatch(nk, logger, roomCode);
  const username = body.username?.trim() || ctx.username || `Player-${ctx.userId.slice(0, 6)}`;

  let snapshot = room.snapshot as SerializedState;
  if (!body.spectator && snapshot.status !== 'finished') {
    snapshot = addPlayer(snapshot, ctx.userId, username);
    snapshot = startIfReady(snapshot);
  }

  const updatedRoom = buildRoomRecord(snapshot, matchId, room.createdBy);
  writeRoom(nk, updatedRoom);

  return JSON.stringify({
    roomCode,
    matchId,
    snapshot,
    spectator: Boolean(body.spectator),
  });
};

const getRoomRpc: nkruntime.RpcFunction = function (_ctx, logger, nk, payload) {
  const body = json<{ roomCode: string }>(payload);
  const roomCode = body.roomCode?.trim().toUpperCase();
  if (!roomCode) throw new Error('roomCode is required.');
  const { room, matchId } = ensureRuntimeMatch(nk, logger, roomCode);
  return JSON.stringify({ roomCode, matchId, snapshot: room.snapshot });
};

const listHistoryRpc: nkruntime.RpcFunction = function (_ctx, _logger, nk, _payload) {
  const records = (nk as any).storageList('00000000-0000-0000-0000-000000000000', 'match_history', 50, '', '');
  return JSON.stringify({ items: (records.objects || []).map((o: any) => o.value) });
};

const matchInit: nkruntime.MatchInitFunction<MatchState> = function (_ctx, logger, _nk, params) {
  const snapshot = (params.snapshot ?? null) as SerializedState | null;
  if (!snapshot) throw new Error('snapshot required');
  logger.info('Initializing dots_boxes for room %s', snapshot.roomCode);
  return {
    state: {
      ...snapshot,
      presences: {},
      matchId: '',
    },
    tickRate: 5,
    label: `roomCode=${snapshot.roomCode}`,
  };
};

const matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<MatchState> = function (_ctx, _logger, _nk, _dispatcher, _tick, state, presence, metadata) {
  const spectator = Boolean((metadata as any)?.spectator);
  if (!spectator && state.status === 'finished' && !state.players.some((p) => p.userId === presence.userId)) {
    return { state, accept: false, rejectMessage: 'Finished game is read-only.' };
  }
  return { state, accept: true };
};

const matchJoin: nkruntime.MatchJoinFunction<MatchState> = function (_ctx, _logger, nk, dispatcher, _tick, state, presences) {
  state.matchId = state.matchId || (_ctx.matchId ?? '');
  for (const presence of presences) {
    state.presences[presence.userId] = presence;
    var existingPlayer = null as any;
    for (var i = 0; i < state.players.length; i += 1) {
      if (state.players[i].userId === presence.userId) { existingPlayer = state.players[i]; break; }
    }
    if (existingPlayer) {
      existingPlayer.isConnected = true;
      existingPlayer.username = presence.username || existingPlayer.username;
    } else {
      const spectator: PresenceRef = {
        userId: presence.userId,
        sessionId: presence.sessionId,
        username: presence.username,
        node: presence.node,
      };
      state.spectators = state.spectators.filter((s) => s.userId !== presence.userId).concat([spectator]);
    }
  }
  writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players[0]?.userId ?? ''));
  dispatcher.broadcastMessage(OpCode.STATE, statePayload(state), presences, null, true);
  dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('presence_joined', { userIds: presences.map((p) => p.userId) }));
  return { state };
};

const matchLeave: nkruntime.MatchLeaveFunction<MatchState> = function (_ctx, _logger, nk, dispatcher, _tick, state, presences) {
  for (const presence of presences) {
    delete state.presences[presence.userId];
    Object.assign(state, markDisconnected(serialize(state), presence.userId));
  }
  writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players[0]?.userId ?? ''));
  dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('presence_left', { userIds: presences.map((p) => p.userId) }));
  dispatcher.broadcastMessage(OpCode.STATE, statePayload(state));
  return { state };
};

const matchLoop: nkruntime.MatchLoopFunction<MatchState> = function (_ctx, logger, nk, dispatcher, _tick, state, messages) {
  for (const message of messages) {
    if (message.opCode !== OpCode.MOVE) continue;
    let payload: { edgeKey: string };
    try {
      payload = JSON.parse(message.data);
    } catch (_err) {
      dispatcher.broadcastMessage(OpCode.ERROR, eventPayload('invalid_payload', { reason: 'Malformed JSON.' }), [message.sender]);
      continue;
    }

    const result = applyMove(serialize(state), message.sender.userId, payload.edgeKey);
    if (result.error) {
      dispatcher.broadcastMessage(OpCode.ERROR, eventPayload('move_rejected', { reason: result.error }), [message.sender]);
      continue;
    }

    Object.assign(state, result.snapshot);
    logger.info('Room %s accepted move %s from %s', state.roomCode, payload.edgeKey, message.sender.userId);
    writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players[0]?.userId ?? ''));
    dispatcher.broadcastMessage(OpCode.STATE, statePayload(state));
    dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('move_accepted', {
      playerId: message.sender.userId,
      edgeKey: payload.edgeKey,
      completedBoxes: result.completedBoxes,
    }));

    if (state.status === 'finished' && state.finishedAt) {
      writeHistory(nk, buildHistory(serialize(state)));
      dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('game_finished', {
        winnerIds: state.winnerIds,
        scores: state.scores,
      }));
    }
  }
  return { state };
};

const matchTerminate: nkruntime.MatchTerminateFunction<MatchState> = function (_ctx, _logger, nk, dispatcher, _tick, state, _graceSeconds) {
  writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players[0]?.userId ?? ''));
  dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('match_terminating', { roomCode: state.roomCode }));
  return { state };
};

const matchSignal: nkruntime.MatchSignalFunction<MatchState> = function (_ctx, _logger, _nk, _dispatcher, _tick, state, data) {
  return { state, data };
};

let InitModule: nkruntime.InitModule = function (_ctx, logger, _nk, initializer) {
  initializer.registerRpc('create_room', createRoomRpc);
  initializer.registerRpc('join_room', joinRoomRpc);
  initializer.registerRpc('get_room', getRoomRpc);
  initializer.registerRpc('list_history', listHistoryRpc);
  initializer.registerMatch('dots_boxes', {
    matchInit,
    matchJoinAttempt,
    matchJoin,
    matchLeave,
    matchLoop,
    matchTerminate,
    matchSignal,
  });
  logger.info('Dots and Boxes runtime loaded.');
};

(globalThis as any).InitModule = InitModule;
