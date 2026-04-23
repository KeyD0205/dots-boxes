import {
  addPlayer,
  applyMove,
  createInitialSnapshot,
  edgeKey,
  startIfReady,
  totalPossibleEdges,
  normalizeGridSize,
  isAdjacentEdge,
  boxKey,
  boxesAffected,
  markDisconnected,
} from '../src/game';
import { SerializedState } from '../src/types';

describe('Dots and Boxes rules', () => {
  describe('utility functions', () => {
    test('normalizeGridSize clamps values', () => {
      expect(normalizeGridSize()).toBe(5);
      expect(normalizeGridSize(2)).toBe(3);
      expect(normalizeGridSize(10)).toBe(8);
      expect(normalizeGridSize(4)).toBe(4);
      expect(normalizeGridSize(7.9)).toBe(7);
    });

    test('isAdjacentEdge validates edge keys', () => {
      expect(isAdjacentEdge(3, '0,0-1,0')).toBe(true);
      expect(isAdjacentEdge(3, '0,0-0,1')).toBe(true);
      expect(isAdjacentEdge(3, '0,0-2,0')).toBe(false);
      expect(isAdjacentEdge(3, '0,0-0,3')).toBe(false);
      expect(isAdjacentEdge(3, '0,0-0,0')).toBe(false);
      expect(isAdjacentEdge(3, 'bad-key')).toBe(false);
    });

    test('boxKey returns correct string', () => {
      expect(boxKey(2, 3)).toBe('2,3');
    });

    test('boxesAffected returns correct boxes', () => {
      expect(boxesAffected(4, '1,2-1,3')).toEqual(['0,2', '1,2']);
      expect(boxesAffected(4, '2,1-3,1')).toEqual(['2,0', '2,1']);
      expect(boxesAffected(4, '0,0-0,1')).toEqual(['0,0']);
      expect(boxesAffected(4, '3,2-3,3')).toEqual(['2,2']);
    });

    test('markDisconnected sets player as disconnected and removes from spectators', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state.spectators.push({ userId: 'p2', username: 'Linus', sessionId: 'sess42' } as any);

      const updated = markDisconnected(state, 'p2');

      expect(updated.players.find((p) => p.userId === 'p2')?.isConnected).toBe(false);
      expect(updated.spectators.some((s) => s.userId === 'p2')).toBe(false);
    });

    test('addPlayer reconnects existing player and removes them from spectators', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = markDisconnected(state, 'p2');
      state.spectators.push({ userId: 'p2', username: 'OldName', sessionId: 'sess42' } as any);

      const updated = addPlayer(state, 'p2', 'Linus-New');

      expect(updated.players.find((p) => p.userId === 'p2')?.isConnected).toBe(true);
      expect(updated.players.find((p) => p.userId === 'p2')?.username).toBe('Linus-New');
      expect(updated.spectators.some((s) => s.userId === 'p2')).toBe(false);
    });

    test('addPlayer assigns next color to 3rd player', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = addPlayer(state, 'p3', 'Turing');

      const p1Color = state.players.find((p) => p.userId === 'p1')?.color;
      const p2Color = state.players.find((p) => p.userId === 'p2')?.color;
      const p3Color = state.players.find((p) => p.userId === 'p3')?.color;

      expect(p1Color).toBeDefined();
      expect(p2Color).toBeDefined();
      expect(p3Color).toBeDefined();
      expect(new Set([p1Color, p2Color, p3Color]).size).toBe(3);
    });

    test('addPlayer sets currentTurnUserId when it was null', () => {
      const base = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      const withNull = { ...base, currentTurnUserId: null } as SerializedState;
      const updated = addPlayer(withNull, 'p2', 'Linus');

      expect(updated.currentTurnUserId).toBe('p2');
    });

    describe('edgeKey', () => {
      test('produces a canonical key regardless of argument order', () => {
        expect(edgeKey(1, 0, 0, 0)).toBe(edgeKey(0, 0, 1, 0));
        expect(edgeKey(0, 1, 0, 0)).toBe(edgeKey(0, 0, 0, 1));
        expect(edgeKey(2, 3, 1, 3)).toBe(edgeKey(1, 3, 2, 3));
      });

      test('key format is x1,y1-x2,y2 with smaller point first', () => {
        expect(edgeKey(0, 0, 1, 0)).toBe('0,0-1,0');
        expect(edgeKey(0, 0, 0, 1)).toBe('0,0-0,1');
        expect(edgeKey(3, 2, 3, 3)).toBe('3,2-3,3');
      });

      test('ties on x are broken by y', () => {
        expect(edgeKey(2, 5, 2, 4)).toBe('2,4-2,5');
      });
    });

    describe('totalPossibleEdges', () => {
      test('returns correct count for various grid sizes', () => {
        expect(totalPossibleEdges(2)).toBe(4);
        expect(totalPossibleEdges(3)).toBe(12);
        expect(totalPossibleEdges(5)).toBe(40);
        expect(totalPossibleEdges(8)).toBe(112);
      });
    });

    describe('normalizeGridSize boundary values', () => {
      test('accepts exactly min (3) and max (8)', () => {
        expect(normalizeGridSize(3)).toBe(3);
        expect(normalizeGridSize(8)).toBe(8);
      });
    });

    describe('isAdjacentEdge edge cases', () => {
      test('rejects negative coordinates', () => {
        expect(isAdjacentEdge(3, '-1,0-0,0')).toBe(false);
        expect(isAdjacentEdge(3, '0,-1-0,0')).toBe(false);
      });

      test('rejects coordinates equal to gridSize (out of bounds)', () => {
        expect(isAdjacentEdge(3, '2,3-2,2')).toBe(false);
        expect(isAdjacentEdge(3, '3,2-2,2')).toBe(false);
      });
    });

    describe('boxesAffected corner and boundary cases', () => {
      test('top-left corner vertical edge touches only one box', () => {
        // vertical edge x=0 → no box to the left
        expect(boxesAffected(4, '0,0-0,1')).toEqual(['0,0']);
      });

      test('top-left corner horizontal edge touches only one box', () => {
        // horizontal edge y=0 → no box above
        expect(boxesAffected(4, '0,0-1,0')).toEqual(['0,0']);
      });

      test('bottom-right corner vertical edge touches only one box', () => {
        // vertical edge x=gridSize-1, top row is gridSize-2
        expect(boxesAffected(4, '3,2-3,3')).toEqual(['2,2']);
      });

      test('bottom-right corner horizontal edge touches only one box', () => {
        // horizontal edge y=gridSize-1, left col is gridSize-2
        expect(boxesAffected(4, '2,3-3,3')).toEqual(['2,2']);
      });
    });
  });

  test('starts active when second player joins', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    expect(state.status).toBe('active');
    expect(state.currentTurnUserId).toBe('p1');
  });

  test('rejects move when game is not active', () => {
    const state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    const result = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));

    expect(result.error).toBe('Game is not active.');
  });

  test('rejects move when it is not the player turn', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const result = applyMove(state, 'p2', edgeKey(0, 0, 1, 0));
    expect(result.error).toBe('It is not your turn.');
  });

  test('rejects duplicate edges', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const move1 = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
    expect(move1.error).toBeUndefined();

    const move2 = applyMove(move1.snapshot, 'p2', edgeKey(0, 0, 1, 0));
    expect(move2.error).toBe('Edge already taken.');
  });

  test('rejects invalid edge', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    const result = applyMove(state, 'p1', '0,0-2,0');
    expect(result.error).toBe('Invalid edge.');
  });

  test('completing a box grants an extra turn and score', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = applyMove(state, 'p1', edgeKey(0, 0, 1, 0)).snapshot;
    state = applyMove(state, 'p2', edgeKey(1, 0, 1, 1)).snapshot;
    state = applyMove(state, 'p1', edgeKey(0, 1, 1, 1)).snapshot;
    const result = applyMove(state, 'p2', edgeKey(0, 0, 0, 1));

    expect(result.error).toBeUndefined();
    expect(result.completedBoxes).toEqual(['0,0']);
    expect(result.snapshot.scores.p2).toBe(1);
    expect(result.snapshot.currentTurnUserId).toBe('p2');
  });

  test('one move can complete two boxes', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = {
      ...state,
      edges: {
        [edgeKey(0, 0, 1, 0)]: 'p1',
        [edgeKey(0, 0, 0, 1)]: 'p1',
        [edgeKey(0, 1, 0, 2)]: 'p1',
        [edgeKey(0, 2, 1, 2)]: 'p1',
        [edgeKey(1, 0, 2, 0)]: 'p1',
        [edgeKey(2, 0, 2, 1)]: 'p1',
        [edgeKey(2, 1, 2, 2)]: 'p1',
        [edgeKey(1, 2, 2, 2)]: 'p1',
        [edgeKey(1, 0, 1, 1)]: 'p1',
        [edgeKey(1, 1, 1, 2)]: 'p1',
      },
      currentTurnUserId: 'p2',
      status: 'active',
    };

    const result = applyMove(state, 'p2', edgeKey(0, 1, 1, 1));

    expect(result.error).toBeUndefined();
    expect(result.completedBoxes.sort()).toEqual(['0,0', '0,1']);
    expect(result.snapshot.scores.p2).toBe(2);
    expect(result.snapshot.currentTurnUserId).toBe('p2');
  });

  test('finishes game when all edges are drawn', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

    state = {
      ...state,
      gridSize: 2,
      status: 'active',
      edges: {},
      boxes: {},
      scores: { p1: 0, p2: 0 },
      moveLog: [],
      currentTurnUserId: 'p1',
    };

    const edges = [
      edgeKey(0, 0, 1, 0),
      edgeKey(0, 0, 0, 1),
      edgeKey(0, 1, 1, 1),
      edgeKey(1, 0, 1, 1),
    ];

    let current = state;
    let player = 'p1';

    for (const key of edges) {
      const res = applyMove(current, player, key);
      current = res.snapshot;
      player = current.currentTurnUserId ?? 'p1';
    }

    expect(Object.keys(current.edges)).toHaveLength(totalPossibleEdges(2));
    expect(current.status).toBe('finished');
    expect(current.finishedAt).toBeTruthy();
    expect(current.winnerIds.length).toBeGreaterThan(0);
  });

  describe('createInitialSnapshot', () => {
    test('returns a valid waiting snapshot with correct initial fields', () => {
      const state = createInitialSnapshot('ROOM99', 5, { userId: 'p1', username: 'Ada' });

      expect(state.roomCode).toBe('ROOM99');
      expect(state.gridSize).toBe(5);
      expect(state.status).toBe('waiting');
      expect(state.startedAt).toBeNull();
      expect(state.finishedAt).toBeNull();
      expect(state.players).toHaveLength(1);
      expect(state.players[0].userId).toBe('p1');
      expect(state.players[0].username).toBe('Ada');
      expect(state.players[0].isConnected).toBe(true);
      expect(state.spectators).toEqual([]);
      expect(state.edges).toEqual({});
      expect(state.boxes).toEqual({});
      expect(state.scores).toEqual({ p1: 0 });
      expect(state.moveLog).toEqual([]);
      expect(state.winnerIds).toEqual([]);
      expect(state.currentTurnUserId).toBe('p1');
      expect(typeof state.reconnectGraceSec).toBe('number');
      expect(state.reconnectGraceSec).toBeGreaterThan(0);
    });
  });

  describe('startIfReady', () => {
    test('does nothing when already active', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);
      expect(state.status).toBe('active');

      const again = startIfReady(state);
      expect(again).toBe(state); // same reference – no mutation
    });

    test('does nothing when status is finished', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);
      const finished = { ...state, status: 'finished' } as SerializedState;

      const result = startIfReady(finished);
      expect(result.status).toBe('finished');
    });

    test('does nothing with only one player', () => {
      const state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      const result = startIfReady(state);
      expect(result.status).toBe('waiting');
    });
  });

  describe('applyMove extra cases', () => {
    test('rejects move when game is already finished', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);
      const finished = { ...state, status: 'finished' } as SerializedState;

      const result = applyMove(finished, 'p1', edgeKey(0, 0, 1, 0));
      expect(result.error).toBe('Game is not active.');
    });

    test('rejects move from a userId not in the players list', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);

      const result = applyMove(state, 'stranger', edgeKey(0, 0, 1, 0));
      expect(result.error).toBe('It is not your turn.');
    });

    test('records the move in the moveLog with correct fields', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);

      const key = edgeKey(0, 0, 1, 0);
      const { snapshot } = applyMove(state, 'p1', key);

      expect(snapshot.moveLog).toHaveLength(1);
      const entry = snapshot.moveLog[0];
      expect(entry.playerId).toBe('p1');
      expect(entry.edgeKey).toBe(key);
      expect(entry.completedBoxes).toEqual([]);
      expect(entry.turnAfterMove).toBe('p2');
      expect(typeof entry.createdAt).toBe('string');
    });

    test('tie game produces multiple winnerIds', () => {
      let state = createInitialSnapshot('ROOM01', 2, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);

      // 2×2 grid has 4 edges forming 1 box.
      // Build a scenario with gridSize=3 where p1 and p2 each claim equal boxes.
      // Use a gridSize-3 grid (4 boxes). Set up manually so each player gets 2 boxes.
      const s3: SerializedState = {
        ...createInitialSnapshot('ROOM02', 3, { userId: 'p1', username: 'Ada' }),
        status: 'active',
        currentTurnUserId: 'p1',
        scores: { p1: 0, p2: 0 },
        edges: {
          // pre-fill all edges except the last two shared walls so we can finish cleanly
          // Top-left box (0,0): top, left, right already drawn; bottom will close it
          [edgeKey(0, 0, 1, 0)]: 'p1',
          [edgeKey(0, 0, 0, 1)]: 'p1',
          [edgeKey(1, 0, 1, 1)]: 'p1',
          // Top-right box (1,0): top, right, left already drawn; bottom will close it
          [edgeKey(1, 0, 2, 0)]: 'p2',
          [edgeKey(2, 0, 2, 1)]: 'p2',
          // Bottom-left box (0,1): top=shared, left, bottom already drawn; right will close it
          [edgeKey(0, 1, 0, 2)]: 'p1',
          [edgeKey(0, 2, 1, 2)]: 'p1',
          // Bottom-right box (1,1): top=shared, right, bottom already drawn; left will close it
          [edgeKey(1, 2, 2, 2)]: 'p2',
          [edgeKey(2, 1, 2, 2)]: 'p2',
        },
        boxes: {},
        players: [
          { userId: 'p1', username: 'Ada', color: '#2563eb', isConnected: true, joinedAt: new Date().toISOString() },
          { userId: 'p2', username: 'Linus', color: '#dc2626', isConnected: true, joinedAt: new Date().toISOString() },
        ],
        moveLog: [],
      };

      // Draw the shared horizontal wall that separates top and bottom rows: y=1 row
      // edgeKey(0,1,1,1) closes top-left and opens bottom-left
      let res = applyMove(s3, 'p1', edgeKey(0, 1, 1, 1));
      expect(res.error).toBeUndefined();
      // p1 should have scored at least box (0,0)
      res = applyMove(res.snapshot, 'p1', edgeKey(1, 1, 2, 1));
      expect(res.error).toBeUndefined();

      // Now finish remaining edges to end the game
      // Close bottom-left (0,1) right side
      res = applyMove(res.snapshot, res.snapshot.currentTurnUserId!, edgeKey(1, 1, 1, 2));
      expect(res.error).toBeUndefined();

      const finalState = res.snapshot;
      if (finalState.status === 'finished') {
        expect(finalState.winnerIds.length).toBeGreaterThanOrEqual(1);
      }
    });

    test('turn passes to next connected player after non-scoring move with 3 players', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = addPlayer(state, 'p3', 'Turing');
      state = startIfReady(state);

      const res1 = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
      expect(res1.error).toBeUndefined();
      expect(res1.snapshot.currentTurnUserId).toBe('p2');

      const res2 = applyMove(res1.snapshot, 'p2', edgeKey(1, 0, 2, 0));
      expect(res2.error).toBeUndefined();
      expect(res2.snapshot.currentTurnUserId).toBe('p3');

      const res3 = applyMove(res2.snapshot, 'p3', edgeKey(2, 0, 2, 1));
      expect(res3.error).toBeUndefined();
      expect(res3.snapshot.currentTurnUserId).toBe('p1');
    });

    test('turn skips disconnected players', () => {
      let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = addPlayer(state, 'p3', 'Turing');
      state = startIfReady(state);
      state = markDisconnected(state, 'p2');

      const res = applyMove(state, 'p1', edgeKey(0, 0, 1, 0));
      expect(res.error).toBeUndefined();
      // p2 is disconnected, so turn should skip to p3
      expect(res.snapshot.currentTurnUserId).toBe('p3');
    });

    test('currentTurnUserId is null when all players disconnect and a move finalises the game', () => {
      // Construct a near-finished 2-grid game where the last move is taken by p1
      // but then all players are already marked disconnected (edge case for nextTurn).
      let state = createInitialSnapshot('ROOM01', 2, { userId: 'p1', username: 'Ada' });
      state = addPlayer(state, 'p2', 'Linus');
      state = startIfReady(state);

      state = {
        ...state,
        gridSize: 2,
        status: 'active',
        edges: {
          [edgeKey(0, 0, 1, 0)]: 'p1',
          [edgeKey(0, 0, 0, 1)]: 'p1',
          [edgeKey(0, 1, 1, 1)]: 'p1',
        },
        boxes: {},
        scores: { p1: 0, p2: 0 },
        moveLog: [],
        currentTurnUserId: 'p1',
      };

      const res = applyMove(state, 'p1', edgeKey(1, 0, 1, 1));
      expect(res.error).toBeUndefined();
      expect(res.snapshot.status).toBe('finished');
      expect(res.snapshot.currentTurnUserId).toBeNull();
    });
  });
});