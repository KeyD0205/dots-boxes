/// <reference path="../node_modules/nakama-runtime/index.d.ts" />
import { addPlayer, applyMove, createInitialSnapshot, markDisconnected, normalizeGridSize, startIfReady } from './game';
import { buildHistory, buildRoomRecord, readRoom, writeHistory, writeRoom } from './storage';
import { CreateRoomPayload, JoinRoomPayload, MatchState, OpCode, PresenceRef, SerializedState } from './types';

function json<T>(payload: string): T {
  if (!payload) return {} as T;
  try {
    var parsed = JSON.parse(payload);
    // Handle double-encoding: if the result is a string, parse again
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    return parsed as T;
  } catch (e) {
    return {} as T;
  }
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

function eventPayload(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data, at: new Date().toISOString() });
}

function statePayload(state: MatchState): string {
  return JSON.stringify({
    roomCode: state.roomCode,
    matchId: state.matchId,
    snapshot: serialize(state),
  });
}

function randomRoomCode(): string {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < 6; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function ensureRuntimeMatch(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  roomCode: string
): { room: any; matchId: string } {
  var room = readRoom(nk, roomCode);
  if (!room) {
    throw new Error('Room not found.');
  }

  var validMatch = true;
  try {
    nk.matchGet(room.matchId);
  } catch (_err) {
    validMatch = false;
  }

  if (validMatch) {
    return { room: room, matchId: room.matchId };
  }

  var recreatedMatchId = nk.matchCreate('dots_boxes', { roomCode: roomCode, snapshot: room.snapshot });
  var updated = {
    roomCode: room.roomCode,
    matchId: recreatedMatchId,
    gridSize: room.gridSize,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: new Date().toISOString(),
    createdBy: room.createdBy,
    playerOrder: room.playerOrder,
    snapshot: room.snapshot,
    completedAt: room.completedAt,
    winnerIds: room.winnerIds,
  };

  writeRoom(nk, updated);
  logger.info('Recovered room %s into new match %s', roomCode, recreatedMatchId);
  return { room: updated, matchId: recreatedMatchId };
}

function createRoomRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  var body = json<CreateRoomPayload>(payload);
  if (!ctx.userId) {
    throw new Error('Authentication required.');
  }

  var username = (body.username && body.username.trim()) || ctx.username || ('Player-' + ctx.userId.slice(0, 6));
  var gridSize = normalizeGridSize(body.gridSize);

  var roomCode = randomRoomCode();
  while (readRoom(nk, roomCode)) {
    roomCode = randomRoomCode();
  }

  var snapshot = createInitialSnapshot(roomCode, gridSize, { userId: ctx.userId, username: username });
  var matchId = nk.matchCreate('dots_boxes', { roomCode: roomCode, snapshot: snapshot });
  var room = buildRoomRecord(snapshot, matchId, ctx.userId);

  writeRoom(nk, room);
  logger.info('Created room %s match %s', roomCode, matchId);

  return JSON.stringify({ roomCode: roomCode, matchId: matchId, snapshot: snapshot });
}

function joinRoomRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logger.info('joinRoomRpc payload: ' + payload);
  var body = json<JoinRoomPayload>(payload);
  logger.info('parsed body roomCode: ' + JSON.stringify(body));
  if (!ctx.userId) {
    throw new Error('Authentication required.');
  }

  var roomCode = body.roomCode ? body.roomCode.trim().toUpperCase() : '';
  if (!roomCode) {
    throw new Error('roomCode is required.');
  }

  var ensured = ensureRuntimeMatch(nk, logger, roomCode);
  var room = ensured.room;
  var matchId = ensured.matchId;
  var username = (body.username && body.username.trim()) || ctx.username || ('Player-' + ctx.userId.slice(0, 6));

  var snapshot = room.snapshot as SerializedState;
  if (!body.spectator && snapshot.status !== 'finished') {
    snapshot = addPlayer(snapshot, ctx.userId, username);
    snapshot = startIfReady(snapshot);
  }

  var updatedRoom = buildRoomRecord(snapshot, matchId, room.createdBy);
  writeRoom(nk, updatedRoom);

  return JSON.stringify({
    roomCode: roomCode,
    matchId: matchId,
    snapshot: snapshot,
    spectator: Boolean(body.spectator),
  });
}

function getRoomRpc(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  var body = json<{ roomCode: string }>(payload);
  var roomCode = body.roomCode ? body.roomCode.trim().toUpperCase() : '';
  if (!roomCode) {
    throw new Error('roomCode is required.');
  }

  var ensured = ensureRuntimeMatch(nk, logger, roomCode);
  return JSON.stringify({
    roomCode: roomCode,
    matchId: ensured.matchId,
    snapshot: ensured.room.snapshot,
  });
}

function listHistoryRpc(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  _payload: string
): string {
  var records = (nk as any).storageList('00000000-0000-0000-0000-000000000000', 'match_history', 50, '', '');
  var objects = (records && records.objects) ? records.objects : [];
  return JSON.stringify({
    items: objects.map(function (o: any) { return o.value; }),
  });
}

function matchInit(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  params: any
) {
  var snapshot = (params && params.snapshot) ? params.snapshot as SerializedState : null;
  if (!snapshot) {
    throw new Error('snapshot required');
  }

  logger.info('Initializing dots_boxes for room %s', snapshot.roomCode);

  return {
    state: {
      roomCode: snapshot.roomCode,
      gridSize: snapshot.gridSize,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      currentTurnUserId: snapshot.currentTurnUserId,
      players: snapshot.players,
      spectators: snapshot.spectators,
      edges: snapshot.edges,
      boxes: snapshot.boxes,
      scores: snapshot.scores,
      moveLog: snapshot.moveLog,
      winnerIds: snapshot.winnerIds,
      reconnectGraceSec: snapshot.reconnectGraceSec,
      presences: {},
      matchId: '',
    },
    tickRate: 5,
    label: 'roomCode=' + snapshot.roomCode,
  };
}

function matchJoinAttempt(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  presence: nkruntime.Presence,
  metadata: { [key: string]: any }
) {
  var spectator = Boolean(metadata && metadata.spectator);
  var isExistingPlayer = false;
  for (var i = 0; i < state.players.length; i += 1) {
    if (state.players[i].userId === presence.userId) {
      isExistingPlayer = true;
      break;
    }
  }

  if (!spectator && state.status === 'finished' && !isExistingPlayer) {
    return { state: state, accept: false, rejectMessage: 'Finished game is read-only.' };
  }

  return { state: state, accept: true };
}

function matchJoin(
  ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
) {
  state.matchId = state.matchId || ctx.matchId || '';

  for (var p = 0; p < presences.length; p += 1) {
    var presence = presences[p];
    state.presences[presence.userId] = presence;

    var existingPlayer: any = null;
    for (var i = 0; i < state.players.length; i += 1) {
      if (state.players[i].userId === presence.userId) {
        existingPlayer = state.players[i];
        break;
      }
    }

    if (existingPlayer) {
      existingPlayer.isConnected = true;
      existingPlayer.username = presence.username || existingPlayer.username;
    } else {
      var spectator: PresenceRef = {
        userId: presence.userId,
        sessionId: presence.sessionId,
        username: presence.username,
        node: presence.node,
      };

      var filteredSpectators: PresenceRef[] = [];
      for (var s = 0; s < state.spectators.length; s += 1) {
        if (state.spectators[s].userId !== presence.userId) {
          filteredSpectators.push(state.spectators[s]);
        }
      }
      filteredSpectators.push(spectator);
      state.spectators = filteredSpectators;
    }
  }

  writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players.length ? state.players[0].userId : ''));

  dispatcher.broadcastMessage(OpCode.STATE, statePayload(state), presences, null, true);
  dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('presence_joined', {
    userIds: presences.map(function (presence) { return presence.userId; }),
  }));

  return { state: state };
}

function matchLeave(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
) {
  for (var p = 0; p < presences.length; p += 1) {
    var presence = presences[p];
    delete state.presences[presence.userId];
    var updated = markDisconnected(serialize(state), presence.userId);
    Object.assign(state, updated);
  }

  writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players.length ? state.players[0].userId : ''));

  dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('presence_left', {
    userIds: presences.map(function (presence) { return presence.userId; }),
  }));
  dispatcher.broadcastMessage(OpCode.STATE, statePayload(state));

  return { state: state };
}

function matchLoop(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  messages: nkruntime.MatchMessage[]
) {
  for (var m = 0; m < messages.length; m += 1) {
    var message = messages[m];
    if (message.opCode !== OpCode.MOVE) {
      continue;
    }

    var payload: { edgeKey: string };
    try {
      payload = JSON.parse(typeof message.data === 'string' ? message.data : new TextDecoder().decode(message.data));
    } catch (_err) {
      dispatcher.broadcastMessage(
        OpCode.ERROR,
        eventPayload('invalid_payload', { reason: 'Malformed JSON.' }),
        [message.sender]
      );
      continue;
    }

    var result = applyMove(serialize(state), message.sender.userId, payload.edgeKey);
    if (result.error) {
      dispatcher.broadcastMessage(
        OpCode.ERROR,
        eventPayload('move_rejected', { reason: result.error }),
        [message.sender]
      );
      continue;
    }

    Object.assign(state, result.snapshot);

    logger.info('Room %s accepted move %s from %s', state.roomCode, payload.edgeKey, message.sender.userId);

    writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players.length ? state.players[0].userId : ''));

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

  return { state: state };
}

function matchTerminate(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  _graceSeconds: number
) {
  writeRoom(nk, buildRoomRecord(serialize(state), state.matchId, state.players.length ? state.players[0].userId : ''));
  dispatcher.broadcastMessage(OpCode.EVENT, eventPayload('match_terminating', { roomCode: state.roomCode }));
  return { state: state };
}

function matchSignal(
  _ctx: nkruntime.Context,
  _logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  _dispatcher: nkruntime.MatchDispatcher,
  _tick: number,
  state: MatchState,
  data: string
) {
  return { state: state, data: data };
}

function InitModule(
  _ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer
) {
  initializer.registerRpc('create_room', createRoomRpc);
  initializer.registerRpc('join_room', joinRoomRpc);
  initializer.registerRpc('get_room', getRoomRpc);
  initializer.registerRpc('list_history', listHistoryRpc);

  initializer.registerMatch('dots_boxes', {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });

  logger.info('Dots and Boxes runtime loaded.');
}

!InitModule && InitModule.bind(null);