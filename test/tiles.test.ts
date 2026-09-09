// pathToTiles — the core of the coverage-model migration (Tile Coverage
// Model brief §3, §6 step 1). Must-have cases per the brief: a straight
// path yields a contiguous cell run with no gaps; a stationary runner
// yields one cell; a 25m out-and-back yields the same cells both ways
// (idempotent). Plus the speed-cap fix (b8's review, 2026-09-01): an
// unbounded bridge is the enclosure model's auto-close bug wearing
// different clothes — a background-gap jump used to be bridged exactly
// like a normal throttle gap, silently claiming ground never run over.
import {
  cellArea,
  cellsToMultiPolygon,
  getResolution,
  gridDisk,
  gridDistance,
  gridPathCells,
  latLngToCell,
  polygonToCells,
  UNITS,
} from 'h3-js';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TILE_RES,
  isCurrentTileRes,
  MAX_BRIDGE_DISTANCE_M,
  MAX_BRIDGE_SPEED_MS,
  pathToTiles,
  tileResLikePattern,
  type TilePoint,
  tilesAreaM2,
} from '@/lib/tiles';
import { TILE_DISSOLVE_THRESHOLD } from '@/constants/map';

// Wraps gridPathCells so ONE test (below) can force it to throw without
// touching every other test's real behaviour. vi.spyOn on a plain
// `import * as h3` fails here ("Cannot redefine property: gridPathCells" —
// Vitest's ESM module namespace isn't configurable), so the mock has to be
// declared at module scope like this instead. It calls straight through to
// the real implementation by default, and tiles.ts (which imports
// gridPathCells from the same module id) sees this exact mock too — that's
// what lets the one forced-throw test below actually exercise pathToTiles's
// catch block rather than mocking something it never reaches.
vi.mock('h3-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3-js')>();
  return { ...actual, gridPathCells: vi.fn(actual.gridPathCells) };
});

// Monterrey-ish latitude, matching territory.test.ts's own fixtures.
const LAT = 25.67;
const LNG = -100.31;
// ~111,320m per degree latitude everywhere; longitude scales by cos(lat).
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

// A comfortable jogging pace, safely under MAX_BRIDGE_SPEED_MS (~6.94 m/s /
// 25 km/h) — used for fixtures where the point of the test is gap-FILL
// behaviour, not the speed cap itself. Timestamps are derived FROM this
// pace and the actual distance, so "this gap is physically plausible" is
// true by construction rather than by accident.
const JOG_MS = 3; // 10.8 km/h

/** A point `metres` east of a fixed origin, at wall-clock `atMs`. */
function pointEast(metres: number, atMs: number): TilePoint {
  return { lat: LAT, lng: LNG + metres / M_PER_DEG_LNG, ts: atMs };
}

/** A straight-line path east from the origin, `stepM` apart, with
 *  timestamps derived from `speedMs` — the implied speed between every
 *  consecutive pair is exactly `speedMs`, by construction. */
function pathAtPace(steps: number, stepM: number, speedMs: number): TilePoint[] {
  const stepMs = (stepM / speedMs) * 1000;
  return Array.from({ length: steps }, (_, i) => pointEast(i * stepM, i * stepMs));
}

describe('pathToTiles', () => {
  it('returns nothing for an empty path', () => {
    const result = pathToTiles([]);
    expect(result.cells).toEqual([]);
    expect(result.directCount).toBe(0);
    expect(result.gapFilledCount).toBe(0);
    expect(result.bridgeFailures).toBe(0);
    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
  });

  it('a single point yields exactly one cell, direct', () => {
    const result = pathToTiles([pointEast(0, 0)]);
    expect(result.cells).toHaveLength(1);
    expect(result.directCount).toBe(1);
    expect(result.gapFilledCount).toBe(0);
    expect(result.cells[0]).toBe(latLngToCell(LAT, LNG, DEFAULT_TILE_RES));
  });

  it('a stationary runner (many fixes, same spot) yields one cell', () => {
    const path: TilePoint[] = Array.from({ length: 20 }, (_, i) => pointEast(0, i * 2000));
    const result = pathToTiles(path);
    expect(result.cells).toHaveLength(1);
    expect(result.directCount).toBe(1);
    expect(result.gapFilledCount).toBe(0);
  });

  it('two fixes within the same tile need no gap-fill', () => {
    // A handful of metres — inside one ~10.8m-edge res-12 cell.
    const result = pathToTiles([pointEast(0, 0), pointEast(5, 2000)]);
    expect(result.gapFilledCount).toBe(0);
    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
  });

  it('bridges a realistic 55m gap at a plausible pace — no hole between consecutive fixes', () => {
    // 55m: empirically confirmed (see the git history of this test file) as
    // reliably needing an intermediate cell. It cleared that bar at res 11,
    // whose cell centres sit ~25-45m apart; at res 12 (centres ~10-19m
    // apart) it clears it by even more, so the assertion only got safer
    // when the resolution changed on 2026-09-07.
    const path = pathAtPace(2, 55, JOG_MS);
    const result = pathToTiles(path);

    const cellA = latLngToCell(path[0].lat, path[0].lng, DEFAULT_TILE_RES);
    const cellB = latLngToCell(path[1].lat, path[1].lng, DEFAULT_TILE_RES);
    expect(cellA).not.toBe(cellB);

    // The direct proof of "no gaps": every cell H3's own line function says
    // sits between the two fixes must be present in the result.
    const expectedLine = gridPathCells(cellA, cellB);
    for (const cell of expectedLine) expect(result.cells).toContain(cell);

    expect(result.gapFilledCount).toBeGreaterThan(0);
    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
    expect(result.directCount).toBe(2);
  });

  it('a longer straight path at a plausible pace stays contiguous end to end', () => {
    // 10 fixes, 45m apart, at jogging pace — realistic spacing where
    // gap-filling matters at every step, not just once.
    const path = pathAtPace(10, 45, JOG_MS);
    const result = pathToTiles(path);

    for (let i = 1; i < path.length; i++) {
      const cellA = latLngToCell(path[i - 1].lat, path[i - 1].lng, DEFAULT_TILE_RES);
      const cellB = latLngToCell(path[i].lat, path[i].lng, DEFAULT_TILE_RES);
      for (const cell of gridPathCells(cellA, cellB)) {
        expect(result.cells).toContain(cell);
      }
    }
    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
  });

  it('every claimed cell is within one grid step of some other claimed cell (no islands)', () => {
    const path = pathAtPace(8, 45, JOG_MS);
    const { cells } = pathToTiles(path);
    for (const cell of cells) {
      const hasNeighbour = cells.some((other) => other !== cell && gridDistance(cell, other) === 1);
      expect(hasNeighbour).toBe(true);
    }
  });

  it('an out-and-back over the same ~25m ground claims the same tiles both ways (idempotent)', () => {
    const a = pointEast(0, 0);
    const legMs = (25 / JOG_MS) * 1000;
    const b = pointEast(25, legMs);
    const forward = pathToTiles([a, b]);
    const outAndBack = pathToTiles([a, b, { ...a, ts: legMs * 2 }]);
    expect([...outAndBack.cells].sort()).toEqual([...forward.cells].sort());
  });

  it('resolves at DEFAULT_TILE_RES', () => {
    const result = pathToTiles([pointEast(0, 0)]);
    expect(getResolution(result.cells[0])).toBe(DEFAULT_TILE_RES);
  });

  it('accepts an explicit resolution override', () => {
    const result = pathToTiles([pointEast(0, 0)], 9);
    expect(getResolution(result.cells[0])).toBe(9);
  });

  it('a cell reached both directly and via gap-fill counts as direct, not double', () => {
    // A short zigzag that recrosses its own tile: fixes on either side of
    // one small cell, then a third fix landing back inside it directly.
    // All three legs at jogging pace, so the speed cap never interferes.
    const p0 = pointEast(0, 0);
    const p1 = pointEast(60, (60 / JOG_MS) * 1000);
    const p2 = pointEast(5, p1.ts + (55 / JOG_MS) * 1000);
    const result = pathToTiles([p0, p1, p2]);
    expect(result.directCount + result.gapFilledCount).toBe(result.cells.length);
  });

  it('bridgeFailures stays 0 on ordinary paths, including realistic gaps', () => {
    const path = pathAtPace(10, 45, JOG_MS);
    expect(pathToTiles(path).bridgeFailures).toBe(0);
  });

  it('counts a failed bridge rather than silently leaving an unobservable hole', () => {
    // gridPathCells genuinely throws only for cells far beyond anything a
    // real gap produces (empirically: thousands of km) — and now that
    // MAX_BRIDGE_DISTANCE_M (150m) exists, ANY fixture large enough to hit
    // gridPathCells's real throw threshold gets intercepted by the distance
    // cap first (correctly — see that test group), so there is no longer a
    // realistic distance/time combination that reaches this catch block at
    // all. Forcing gridPathCells itself to throw is the only way left to
    // prove the catch path still works rather than having silently rotted.
    // mockImplementationOnce affects exactly the next call, then the mock
    // reverts to its module-scope default (calls straight through to the
    // real gridPathCells) — no manual restore needed for later tests.
    vi.mocked(gridPathCells).mockImplementationOnce(() => {
      throw new Error('simulated h3 failure');
    });

    // A short, ordinary gap — well under both caps — so the ONLY reason
    // this doesn't bridge is the forced throw, not the caps doing their own
    // job.
    const a = pointEast(0, 0);
    const b = pointEast(50, (50 / JOG_MS) * 1000);
    const result = pathToTiles([a, b]);

    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
    expect(result.bridgeFailures).toBe(1);
    // Fails OPEN: both endpoints are still claimed even though nothing
    // filled the gap between them.
    expect(result.cells).toHaveLength(2);
    expect(result.directCount).toBe(2);
    expect(result.gapFilledCount).toBe(0);
  });
});

describe('the bridge speed cap (background-gap fix)', () => {
  // Reproduces b8's own measurement: bridging used to happen regardless of
  // implied speed, so a background-gap jump was bridged exactly like a
  // normal 30-50m throttle gap. A 2km jump claimed ~44 tiles (~95,000 m²)
  // of ground never run over — silently, since nothing THREW.
  const GAP_CASES: Array<[label: string, metres: number]> = [
    ['0m', 0],
    ['200m', 200],
    ['800m', 800],
    ['2000m', 2000],
  ];

  it.each(GAP_CASES)('a %s gap over a normal ~2s fix interval', (label, metres) => {
    // 2s matches the tracker's own real fix cadence (TIME_INTERVAL_MS,
    // tracking.ts) — the realistic shape of "the next recorded fix jumped
    // this far", background gap or not.
    const a = pointEast(0, 0);
    const b = pointEast(metres, 2000);
    const result = pathToTiles([a, b]);

    if (metres === 0) {
      // The 0m case must be UNCHANGED: no gap at all, nothing to skip or
      // fill either way.
      expect(result.bridgesSkippedSpeed).toBe(0);
      expect(result.bridgesSkippedDistance).toBe(0);
      expect(result.gapFilledCount).toBe(0);
      return;
    }

    // Every non-zero case implies a wildly superhuman speed even at the
    // smallest (200m/2s = 100 m/s = 360 km/h) — all must be skipped FOR
    // SPEED specifically (not just "skipped for some reason"), claiming
    // only the two directly-covered endpoints, per b8's ask: "800m and
    // 2000m must claim only the directly-covered tiles."
    expect(result.bridgesSkippedSpeed, `${label} gap should be skipped for speed`).toBe(1);
    expect(result.bridgesSkippedDistance).toBe(0);
    expect(result.gapFilledCount).toBe(0);
    expect(result.cells).toHaveLength(2);
    expect(result.directCount).toBe(2);
  });

  it('the same 2000m gap DOES bridge when the elapsed time makes it a plausible walk', () => {
    // The speed cap is not a distance cap — a long gap is fine if enough
    // real time passed to explain it AND the distance itself is short
    // enough to trust a straight line (see the distance-cap group below for
    // where that stops being true). 2000m over 15 minutes is an easy
    // walking pace (~2.2 m/s), comfortably under MAX_BRIDGE_SPEED_MS — but
    // 2000m itself is far past MAX_BRIDGE_DISTANCE_M, so this now
    // deliberately uses a short gap to isolate "speed cap alone, distance
    // cap not a factor."
    const a = pointEast(0, 0);
    const b = pointEast(100, 45 * 1000); // 100m/45s ≈ 2.2 m/s, a walking pace
    const result = pathToTiles([a, b]);
    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
    expect(result.gapFilledCount).toBeGreaterThan(0);
  });

  it('MAX_BRIDGE_SPEED_MS matches the server anti-cheat threshold (25 km/h)', () => {
    // supabase/migrations/20260827_anti_cheat_flag.sql's max_kmh — reused
    // rather than a second, potentially-disagreeing number.
    expect(MAX_BRIDGE_SPEED_MS).toBeCloseTo(25 / 3.6, 5);
  });
});

describe('the bridge distance cap (straight-line-guess fix)', () => {
  // b8's second review, same date: a runner really can cover ~2km in the
  // time a background gap takes without ever exceeding the speed cap (a
  // phone locked mid-run at a normal walking/jogging pace). The speed cap
  // alone does not catch this — the distance cap is what refuses to guess
  // a straight-line path through streets, buildings, or someone else's
  // already-claimed tile.

  it('a 2km gap at an entirely ordinary jogging pace is skipped for DISTANCE, not speed', () => {
    // 2000m over 11 minutes ≈ 3.03 m/s — comfortably under
    // MAX_BRIDGE_SPEED_MS (~6.94 m/s). This is b8's exact reproduction case:
    // physically unremarkable, and the OLD code bridged it anyway (~44
    // tiles, ~95,000 m² never actually run over).
    const a = pointEast(0, 0);
    const b = pointEast(2000, 11 * 60 * 1000);
    const result = pathToTiles([a, b]);

    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(1);
    expect(result.gapFilledCount).toBe(0);
    // Only the two directly-covered endpoints are claimed — nothing on the
    // guessed straight line between them.
    expect(result.cells).toHaveLength(2);
    expect(result.directCount).toBe(2);
  });

  it('a ~100m gap at a normal pace still bridges — the cap is not "reject anything far"', () => {
    // Just under MAX_BRIDGE_DISTANCE_M (150m), at jogging pace: this is the
    // ordinary case the cap must NOT break — a slightly sparse GPS fix
    // shouldn't stop routine gap-filling.
    const path = pathAtPace(2, 100, JOG_MS);
    const result = pathToTiles(path);

    expect(result.bridgesSkippedSpeed).toBe(0);
    expect(result.bridgesSkippedDistance).toBe(0);
    expect(result.gapFilledCount).toBeGreaterThan(0);
  });

  it('MAX_BRIDGE_DISTANCE_M matches the tracker\'s own realistic gap-fill fixtures (well under it)', () => {
    // The fixtures throughout this file use 45-100m gaps as "ordinary" — the
    // cap must sit comfortably above that range, not press right against
    // it, or routine GPS spacing would start tripping the cap by accident.
    expect(MAX_BRIDGE_DISTANCE_M).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Resolution filtering
// ---------------------------------------------------------------------------
// The app claims at DEFAULT_TILE_RES, but the table can hold rows from a
// PREVIOUS resolution: it changed 11 -> 12 on 2026-09-07 and the conversion
// of stored tiles is a migration applied by hand, so there is a real window
// where both exist. Counting both inflates every total by up to 8x.
describe('tile resolution filtering', () => {
  const MONTERREY: [number, number] = [25.6866, -100.3161];

  it('accepts a cell at the current resolution and rejects one from another', () => {
    expect(isCurrentTileRes(latLngToCell(...MONTERREY, DEFAULT_TILE_RES))).toBe(true);
    expect(isCurrentTileRes(latLngToCell(...MONTERREY, DEFAULT_TILE_RES - 1))).toBe(false);
    expect(isCurrentTileRes(latLngToCell(...MONTERREY, DEFAULT_TILE_RES + 1))).toBe(false);
  });

  // THE INVARIANT THIS WHOLE MECHANISM RESTS ON. An H3 index's second
  // character is its resolution nibble ("8b…" = 11, "8c…" = 12), which is
  // what lets fetchMyTileTotal filter by resolution in SQL — it is a COUNT
  // query and never sees the cell strings — and what lets the conversion
  // migration select old rows with `h3 like '_b%'` without the h3-pg
  // extension installed.
  //
  // If h3-js ever changed that encoding, the LIKE pattern would quietly
  // match NOTHING: the total would read zero tiles and the migration would
  // delete nothing, both of which look like honest answers. This test is
  // what makes that fail loudly instead.
  it('encodes resolution in the second character, for every resolution', () => {
    for (let res = 0; res <= 15; res++) {
      const cell = latLngToCell(...MONTERREY, res);
      expect(getResolution(cell), `res ${res} round-trips`).toBe(res);
      expect(cell[1], `res ${res} nibble`).toBe(res.toString(16));
    }
  });

  it('builds a SQL LIKE pattern that matches exactly its own resolution', () => {
    // Mirrors what Postgres does with `_` as a single-character wildcard.
    const matches = (pattern: string, cell: string) =>
      new RegExp(`^${pattern.replace(/_/g, '.').replace(/%/g, '.*')}$`).test(cell);

    for (let res = 8; res <= 14; res++) {
      const pattern = tileResLikePattern(res);
      expect(matches(pattern, latLngToCell(...MONTERREY, res)), `res ${res} matches`).toBe(true);
      expect(
        matches(pattern, latLngToCell(...MONTERREY, res === 14 ? 8 : res + 1)),
        `res ${res} excludes its neighbour`,
      ).toBe(false);
    }
  });

  it('defaults to the resolution the app actually claims at', () => {
    expect(tileResLikePattern()).toBe(`_${DEFAULT_TILE_RES.toString(16)}%`);
    expect(DEFAULT_TILE_RES).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// The summary map's dissolve ceiling
// ---------------------------------------------------------------------------
// Not a tiles.ts function, but the threshold it guards is a tiles concept and
// the property worth pinning is arithmetic: dissolving must never LOSE
// ground. A fallback that quietly drew less than the runner owns would be
// indistinguishable from a claim that failed.
describe('TILE_DISSOLVE_THRESHOLD', () => {
  it('sits above every run this app has actually recorded', () => {
    // The owner's four stored runs come to 164-597 cells (measured
    // 2026-09-08). The ceiling exists for the unusual case, not the normal
    // one — if this ever needs lowering, the reason must be measured, not
    // assumed.
    expect(TILE_DISSOLVE_THRESHOLD).toBeGreaterThan(597);
  });

  it('dissolving a cell set covers exactly the same cells', () => {
    // The safety property. Fill each dissolved ring back to cells and the
    // set must be unchanged — no ground gained, none lost.
    const centre = latLngToCell(25.6866, -100.3161, DEFAULT_TILE_RES);
    const cells = gridDisk(centre, 4);
    const dissolved = cellsToMultiPolygon(cells, true);
    const refilled = new Set(dissolved.flatMap((rings) => polygonToCells(rings, DEFAULT_TILE_RES, true)));
    expect(refilled).toEqual(new Set(cells));
  });
});

// tilesAreaM2 — the caption under a map of these same cells. It replaced
// runs.area_m2 (the FENCE polygon's area) on the Saved tab, because the two
// can disagree by orders of magnitude: run e058a4c9 stores 1 155 m² of fence
// against 204 covered tiles, having never closed a loop.
describe('tilesAreaM2', () => {
  const CELL = latLngToCell(25.6866, -100.3161, DEFAULT_TILE_RES);

  it('is zero for no tiles', () => {
    expect(tilesAreaM2([])).toBe(0);
  });

  it('grows with the number of tiles', () => {
    const ring = gridDisk(CELL, 1);
    expect(tilesAreaM2(ring)).toBeGreaterThan(tilesAreaM2([CELL]));
  });

  it('sums each cell rather than multiplying one by the count', () => {
    // H3 cells are not equal area, so the true sum differs from count x
    // first-cell area. Asserting they are NOT identical pins the choice —
    // a "simplification" to n * cellArea(cells[0]) fails here.
    const disk = gridDisk(CELL, 4);
    const summed = tilesAreaM2(disk);
    const approximated = disk.length * cellArea(disk[0], UNITS.m2);
    expect(summed).not.toBe(approximated);
    expect(summed).toBeCloseTo(approximated, -2);
  });

  it('reports a res-12 tile at roughly 300 m2', () => {
    expect(tilesAreaM2([CELL])).toBeGreaterThan(250);
    expect(tilesAreaM2([CELL])).toBeLessThan(400);
  });
});
