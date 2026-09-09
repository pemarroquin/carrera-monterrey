// Board 2 — mayorship over ground you keep returning to. The mechanic that
// replaced user-named areas.
//
// Everything here is pure (no Postgres, no renderer), which is exactly the
// scope this suite covers — see vitest.config.ts's header. What it does NOT
// cover: that `tile_visits` actually contains a row per cell per run. That
// is SQL and a real device.
import { latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { districtOf, districtOfCell } from '../src/lib/district';
import {
  MAYORSHIP_WINDOW_DAYS,
  cellsHeldBy,
  contestedCells,
  mayorByCell,
  rankMayors,
  type TileVisitRow,
} from '../src/lib/mayorship';

const MTY = { lat: 25.6866, lng: -100.3161 };
// Far enough to be a different res-7 district (~2.8 km across), not merely a
// different res-12 cell. 0.2° of longitude is ~20 km at this latitude.
const FAR = { lat: 25.6866, lng: -100.5161 };

const CELL_A = latLngToCell(MTY.lat, MTY.lng, 12);
const CELL_B = latLngToCell(MTY.lat + 0.0004, MTY.lng, 12);
const CELL_FAR = latLngToCell(FAR.lat, FAR.lng, 12);

const NOW = Date.parse('2026-09-08T12:00:00.000Z');

/** `daysAgo` whole days before NOW. */
function visit(
  h3: string,
  userId: string,
  daysAgo: number,
  displayName: string | null = null,
): TileVisitRow {
  return {
    h3,
    userId,
    displayName,
    visitedAt: new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  };
}

describe('mayorByCell', () => {
  it('gives the cell to whoever showed up on more distinct days', () => {
    const mayors = mayorByCell(
      [
        visit(CELL_A, 'daniel', 1),
        visit(CELL_A, 'daniel', 2),
        visit(CELL_A, 'daniel', 3),
        visit(CELL_A, 'rival', 1),
        visit(CELL_A, 'rival', 2),
      ],
      NOW,
    );
    expect(mayors.get(CELL_A)).toEqual({ userId: 'daniel', days: 3 });
  });

  it('counts a day once however many times it was run — Pedro\'s 365 vs 362', () => {
    // The mechanic in one assertion: a rival cannot buy the title with
    // volume. Ten visits on two days lose to three visits on three days.
    const mayors = mayorByCell(
      [
        visit(CELL_A, 'daniel', 1),
        visit(CELL_A, 'daniel', 2),
        visit(CELL_A, 'daniel', 3),
        ...Array.from({ length: 10 }, () => visit(CELL_A, 'rival', 1)),
        ...Array.from({ length: 10 }, () => visit(CELL_A, 'rival', 2)),
      ],
      NOW,
    );
    expect(mayors.get(CELL_A)).toEqual({ userId: 'daniel', days: 3 });
  });

  it('keeps the title with the incumbent on a tie', () => {
    // Foursquare's rule, and the backlog's: drawing level is not taking it.
    // Without this the title flips every week between two equally regular
    // runners, and a title that flips on noise is not worth defending.
    const mayors = mayorByCell(
      [
        visit(CELL_A, 'incumbent', 20),
        visit(CELL_A, 'incumbent', 19),
        visit(CELL_A, 'challenger', 2),
        visit(CELL_A, 'challenger', 1),
      ],
      NOW,
    );
    expect(mayors.get(CELL_A)?.userId).toBe('incumbent');
  });

  it('takes the title when the challenger goes one day better', () => {
    const mayors = mayorByCell(
      [
        visit(CELL_A, 'incumbent', 20),
        visit(CELL_A, 'incumbent', 19),
        visit(CELL_A, 'challenger', 3),
        visit(CELL_A, 'challenger', 2),
        visit(CELL_A, 'challenger', 1),
      ],
      NOW,
    );
    expect(mayors.get(CELL_A)?.userId).toBe('challenger');
  });

  it('leaves a cell with NO mayor once the window passes — this is the decay', () => {
    const stale = mayorByCell([visit(CELL_A, 'daniel', MAYORSHIP_WINDOW_DAYS + 1)], NOW);
    expect(stale.has(CELL_A)).toBe(false);
    // One day inside the window is enough to hold it.
    const fresh = mayorByCell([visit(CELL_A, 'daniel', MAYORSHIP_WINDOW_DAYS - 1)], NOW);
    expect(fresh.get(CELL_A)?.userId).toBe('daniel');
  });

  it('drops an unparseable timestamp rather than treating it as now', () => {
    // A NaN must fail both window comparisons. Counting it as recent would
    // hand out a title nobody earned.
    const mayors = mayorByCell(
      [{ h3: CELL_A, userId: 'ghost', displayName: null, visitedAt: 'not-a-date' }],
      NOW,
    );
    expect(mayors.has(CELL_A)).toBe(false);
  });

  it('ignores a visit dated in the future', () => {
    const mayors = mayorByCell([visit(CELL_A, 'ghost', -5)], NOW);
    expect(mayors.has(CELL_A)).toBe(false);
  });

  it('decides each cell independently', () => {
    const mayors = mayorByCell(
      [
        visit(CELL_A, 'daniel', 1),
        visit(CELL_A, 'daniel', 2),
        visit(CELL_B, 'laura', 1),
        visit(CELL_B, 'laura', 2),
        visit(CELL_B, 'laura', 3),
        visit(CELL_B, 'daniel', 1),
      ],
      NOW,
    );
    expect(mayors.get(CELL_A)?.userId).toBe('daniel');
    expect(mayors.get(CELL_B)?.userId).toBe('laura');
  });
});

describe('rankMayors', () => {
  it('ranks by cells held, not by days on one cell', () => {
    // The whole point of cellsHeld being the score: someone devoted to a
    // single cell must not outrank someone who is mayor of a neighbourhood.
    const entries = rankMayors(
      [
        // 'spread' is mayor of two cells, two days each.
        visit(CELL_A, 'spread', 1),
        visit(CELL_A, 'spread', 2),
        visit(CELL_B, 'spread', 1),
        visit(CELL_B, 'spread', 2),
      ],
      null,
      NOW,
    );
    expect(entries[0]).toMatchObject({ userId: 'spread', cellsHeld: 2, bestDays: 2 });
  });

  it('reports bestDays as the best single cell, not a total', () => {
    const entries = rankMayors(
      [
        visit(CELL_A, 'daniel', 1),
        visit(CELL_A, 'daniel', 2),
        visit(CELL_A, 'daniel', 3),
        visit(CELL_B, 'daniel', 1),
      ],
      null,
      NOW,
    );
    expect(entries[0].bestDays).toBe(3);
  });

  it('scopes to a district BEFORE deciding mayorship', () => {
    // A rival's devotion to a park across town must not place them on this
    // district's board at all.
    const district = districtOf(MTY);
    expect(districtOfCell(CELL_FAR)).not.toBe(district);

    const entries = rankMayors(
      [
        visit(CELL_A, 'local', 1),
        visit(CELL_FAR, 'distant', 1),
        visit(CELL_FAR, 'distant', 2),
        visit(CELL_FAR, 'distant', 3),
      ],
      district,
      NOW,
    );
    expect(entries.map((e) => e.userId)).toEqual(['local']);
  });

  it('fills a display name from any row that has one', () => {
    const entries = rankMayors(
      [visit(CELL_A, 'u1', 1, null), visit(CELL_A, 'u1', 2, 'Daniel')],
      null,
      NOW,
    );
    expect(entries[0].displayName).toBe('Daniel');
  });

  it('is a total order — equal scores never reshuffle between loads', () => {
    const rows = [visit(CELL_A, 'bbb', 1), visit(CELL_B, 'aaa', 1)];
    const first = rankMayors(rows, null, NOW).map((e) => e.userId);
    const second = rankMayors([...rows].reverse(), null, NOW).map((e) => e.userId);
    expect(first).toEqual(second);
    expect(first).toEqual(['aaa', 'bbb']);
  });

  it('returns an empty board rather than throwing on no visits', () => {
    expect(rankMayors([], districtOf(MTY), NOW)).toEqual([]);
  });
});

describe('cellsHeldBy', () => {
  it('returns only the cells that runner is mayor of', () => {
    const mayors = mayorByCell(
      [
        visit(CELL_A, 'daniel', 1),
        visit(CELL_B, 'laura', 1),
        visit(CELL_B, 'laura', 2),
        visit(CELL_B, 'daniel', 1),
      ],
      NOW,
    );
    expect(cellsHeldBy(mayors, 'daniel')).toEqual([CELL_A]);
    expect(cellsHeldBy(mayors, 'laura')).toEqual([CELL_B]);
    expect(cellsHeldBy(mayors, 'nobody')).toEqual([]);
  });
});

describe('contestedCells', () => {
  const mayors = () =>
    mayorByCell(
      [
        // laura is mayor of CELL_A (two days vs daniel's one)
        visit(CELL_A, 'laura', 1),
        visit(CELL_A, 'laura', 2),
        visit(CELL_A, 'daniel', 1),
        // daniel is mayor of CELL_B
        visit(CELL_B, 'daniel', 1),
      ],
      NOW,
    );

  it('flags ground you own that someone else runs more', () => {
    expect(contestedCells([CELL_A, CELL_B], mayors(), 'daniel')).toEqual([CELL_A]);
  });

  it('does not flag ground you are mayor of', () => {
    expect(contestedCells([CELL_B], mayors(), 'daniel')).toEqual([]);
  });

  it('does not flag ground with no mayor — nobody to lose it to', () => {
    // A cell nobody has run inside the window. Owning it is not "contested",
    // it is simply quiet.
    const quiet = latLngToCell(MTY.lat + 0.01, MTY.lng, 12);
    expect(contestedCells([quiet], mayors(), 'daniel')).toEqual([]);
  });
});
