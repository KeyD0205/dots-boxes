import { addPlayer, applyMove, createInitialSnapshot, edgeKey, startIfReady, totalPossibleEdges } from '../src/game';

describe('Dots and Boxes rules', () => {
  test('starts active when second player joins', () => {
    let state = createInitialSnapshot('ROOM01', 3, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);
    expect(state.status).toBe('active');
    expect(state.currentTurnUserId).toBe('p1');
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

  test('finishes game when all edges are drawn', () => {
    let state = createInitialSnapshot('ROOM01', 2, { userId: 'p1', username: 'Ada' });
    state = addPlayer(state, 'p2', 'Linus');
    state = startIfReady(state);

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
});
