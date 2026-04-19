import { MatchHistoryRecord, RoomRecord, SerializedState } from './types';

const ROOM_COLLECTION = 'room';
const HISTORY_COLLECTION = 'match_history';
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export function writeRoom(nk: nkruntime.Nakama, room: RoomRecord): void {
  nk.storageWrite([{
    collection: ROOM_COLLECTION,
    key: room.roomCode,
    userId: SYSTEM_USER,
    value: room,
    permissionRead: 2,
    permissionWrite: 0,
  }]);
}

export function readRoom(nk: nkruntime.Nakama, roomCode: string): RoomRecord | null {
  const rows = nk.storageRead([{ collection: ROOM_COLLECTION, key: roomCode, userId: SYSTEM_USER }]);
  if (!rows.length) return null;
  return rows[0].value as RoomRecord;
}

export function writeHistory(nk: nkruntime.Nakama, history: MatchHistoryRecord): void {
  nk.storageWrite([{
    collection: HISTORY_COLLECTION,
    key: `${history.roomCode}:${history.finishedAt}`,
    userId: SYSTEM_USER,
    value: history,
    permissionRead: 2,
    permissionWrite: 0,
  }]);
}

export function buildRoomRecord(snapshot: SerializedState, matchId: string, createdBy: string): RoomRecord {
  const now = new Date().toISOString();
  return {
    roomCode: snapshot.roomCode,
    matchId,
    gridSize: snapshot.gridSize,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: now,
    createdBy,
    playerOrder: snapshot.players.map((p) => p.userId),
    snapshot,
    completedAt: snapshot.finishedAt,
    winnerIds: snapshot.winnerIds,
  };
}

export function buildHistory(snapshot: SerializedState): MatchHistoryRecord {
  const finishedAt = snapshot.finishedAt ?? new Date().toISOString();
  const startedAt = snapshot.startedAt;
  const durationSec = startedAt ? Math.max(0, Math.floor((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)) : 0;
  return {
    roomCode: snapshot.roomCode,
    gridSize: snapshot.gridSize,
    startedAt,
    finishedAt,
    durationSec,
    moves: snapshot.moveLog.length,
    scores: snapshot.scores,
    winnerIds: snapshot.winnerIds,
    players: snapshot.players.map((p) => ({ userId: p.userId, username: p.username, color: p.color })),
    moveLog: snapshot.moveLog,
  };
}
