/// <reference path="../node_modules/nakama-runtime/index.d.ts" />
import { MatchHistoryRecord, RoomRecord, SerializedState } from './types';


const ROOM_COLLECTION = 'room';
const HISTORY_COLLECTION = 'match_history';
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const PERMISSION_READ_PUBLIC = 2;
const PERMISSION_WRITE_SYSTEM = 0;

/**
 * Type guard to check if an object is a RoomRecord.
 */
function isRoomRecord(obj: any): obj is RoomRecord {
  return obj && typeof obj.roomCode === 'string' && typeof obj.matchId === 'string';
}


/**
 * Write a RoomRecord to storage.
 */
export function writeRoom(nk: nkruntime.Nakama, logger: nkruntime.Logger, room: RoomRecord): void {
  try {
    nk.storageWrite([
      {
        collection: ROOM_COLLECTION,
        key: room.roomCode,
        userId: SYSTEM_USER,
        value: room,
        permissionRead: PERMISSION_READ_PUBLIC,
        permissionWrite: PERMISSION_WRITE_SYSTEM,
      },
    ]);
  } catch (err) {
    logger?.error?.(`Failed to write room: ${room.roomCode} - ${err}`);
  }
}


/**
 * Read a RoomRecord from storage by room code.
 */
export function readRoom(nk: nkruntime.Nakama, logger: nkruntime.Logger, roomCode: string): RoomRecord | null {
  try {
    const rows = nk.storageRead([
      { collection: ROOM_COLLECTION, key: roomCode, userId: SYSTEM_USER },
    ]);
    if (!rows.length) return null;
    const value = rows[0].value;
    if (isRoomRecord(value)) {
      return value;
    } else {
      logger?.warn?.(`Storage value for room ${roomCode} is not a valid RoomRecord.`);
      return null;
    }
  } catch (err) {
    logger?.error?.(`Failed to read room: ${roomCode} - ${err}`);
    return null;
  }
}


/**
 * Write a MatchHistoryRecord to storage.
 */
export function writeHistory(nk: nkruntime.Nakama, logger: nkruntime.Logger, history: MatchHistoryRecord): void {
  try {
    nk.storageWrite([
      {
        collection: HISTORY_COLLECTION,
        key: `${history.roomCode}:${history.finishedAt}`,
        userId: SYSTEM_USER,
        value: history,
        permissionRead: PERMISSION_READ_PUBLIC,
        permissionWrite: PERMISSION_WRITE_SYSTEM,
      },
    ]);
  } catch (err) {
    logger?.error?.(`Failed to write history for room: ${history.roomCode} - ${err}`);
  }
}


/**
 * Build a RoomRecord from a SerializedState.
 */
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


/**
 * Build a MatchHistoryRecord from a SerializedState.
 */
export function buildHistory(snapshot: SerializedState): MatchHistoryRecord {
  const finishedAt = snapshot.finishedAt ?? new Date().toISOString();
  const startedAt = snapshot.startedAt;
  const durationSec = startedAt
    ? Math.max(0, Math.floor((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000))
    : 0;
  return {
    roomCode: snapshot.roomCode,
    gridSize: snapshot.gridSize,
    startedAt,
    finishedAt,
    durationSec,
    moves: snapshot.moveLog.length,
    scores: snapshot.scores,
    winnerIds: snapshot.winnerIds,
    players: snapshot.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      color: p.color,
    })),
    moveLog: snapshot.moveLog,
  };
}
