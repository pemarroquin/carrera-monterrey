// Enclosure: the ground a runner surrounds. The safety properties matter as
// much as the happy path here — the enclosure model was tried once before in
// this app and produced a 977,565 m² fence from a 3.3 km one-way run, so the
// cases proving that CANNOT happen again are the point of this file.
import { gridDisk, gridRingUnsafe, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { MAX_NOISE_HOLE_CELLS, enclosedCells, noiseHoles } from '@/lib/enclosure';
import { DEFAULT_TILE_RES, pathToTiles, type TilePoint } from '@/lib/tiles';

const CENTRE = latLngToCell(25.6866, -100.3161, DEFAULT_TILE_RES);

describe('enclosedCells', () => {
  it('fills a closed ring with exactly its interior', () => {
    // A radius-3 ring is a closed loop of 18 cells; everything it surrounds
    // is gridDisk(centre, 2) — 19 cells. Exact, not approximate.
    const ring = gridRingUnsafe(CENTRE, 3);
    const enclosed = enclosedCells(ring, DEFAULT_TILE_RES);
    expect(new Set(enclosed)).toEqual(new Set(gridDisk(CENTRE, 2)));
  });

  it('never returns a cell that was already owned', () => {
    const ring = gridRingUnsafe(CENTRE, 3);
    const enclosed = enclosedCells(ring, DEFAULT_TILE_RES);
    for (const cell of enclosed) expect(ring).not.toContain(cell);
  });

  it('encloses nothing when the ring is BROKEN — a gap leaks', () => {
    // THE safety property. A background interruption leaves a hole in the
    // loop; the region is then not enclosed and nothing may be claimed.
    // "Never connect across a gap" as geometry rather than as a rule this
    // code has to remember.
    const ring = gridRingUnsafe(CENTRE, 3);
    const broken = ring.filter((_, i) => i !== 0);
    expect(enclosedCells(broken, DEFAULT_TILE_RES)).toEqual([]);
  });

  it('encloses nothing for an open path — the 977,565 m² exploit yields zero', () => {
    // A straight one-way run, the shape that auto-closed into a fabricated
    // fence under the OLD enclosure model. No auto-close exists here, so it
    // surrounds nothing at all.
    const straight: TilePoint[] = Array.from({ length: 60 }, (_, i) => ({
      lat: 25.6866 + i * 0.0005,
      lng: -100.3161,
      ts: i * 10_000,
    }));
    const { cells } = pathToTiles(straight);
    expect(cells.length).toBeGreaterThan(10); // it really did cover ground
    expect(enclosedCells(cells, DEFAULT_TILE_RES)).toEqual([]); // and surrounded none
  });

  it('encloses nothing for an out-and-back over the same ground', () => {
    const out: TilePoint[] = Array.from({ length: 30 }, (_, i) => ({
      lat: 25.6866 + i * 0.0005,
      lng: -100.3161,
      ts: i * 10_000,
    }));
    const there = [...out, ...out.slice().reverse().map((p, i) => ({ ...p, ts: 300_000 + i * 10_000 }))];
    expect(enclosedCells(pathToTiles(there).cells, DEFAULT_TILE_RES)).toEqual([]);
  });

  it('handles two separate loops, filling both', () => {
    const far = latLngToCell(25.7266, -100.3561, DEFAULT_TILE_RES);
    const cells = [...gridRingUnsafe(CENTRE, 3), ...gridRingUnsafe(far, 3)];
    const enclosed = new Set(enclosedCells(cells, DEFAULT_TILE_RES));
    expect(enclosed).toEqual(new Set([...gridDisk(CENTRE, 2), ...gridDisk(far, 2)]));
  });

  it('fills a thick ring the same as a thin one', () => {
    // A real loop is several cells wide (GPS wander, gap-fill). The hole is
    // whatever is left inside, regardless of how thick the boundary is.
    const thick = [...gridRingUnsafe(CENTRE, 3), ...gridRingUnsafe(CENTRE, 4)];
    expect(new Set(enclosedCells(thick, DEFAULT_TILE_RES))).toEqual(new Set(gridDisk(CENTRE, 2)));
  });

  it('returns [] for degenerate input rather than throwing', () => {
    expect(enclosedCells([], DEFAULT_TILE_RES)).toEqual([]);
    expect(enclosedCells([CENTRE], DEFAULT_TILE_RES)).toEqual([]);
    expect(enclosedCells(gridRingUnsafe(CENTRE, 1), DEFAULT_TILE_RES)).toEqual(
      // A radius-1 ring surrounds exactly the centre cell.
      [CENTRE],
    );
  });
});

describe('noiseHoles', () => {
  const centre = latLngToCell(25.6866, -100.3161, DEFAULT_TILE_RES);
  const solid = gridDisk(centre, 6);
  /** `solid` with `hole` punched out of it. */
  const punch = (hole: string[]) => {
    const gone = new Set(hole);
    return solid.filter((c) => !gone.has(c));
  };

  it('fills a hole at or below the cap', () => {
    for (const size of [1, 2, 3, 6]) {
      const hole = gridDisk(centre, 1).slice(0, size);
      const filled = noiseHoles(punch(hole), DEFAULT_TILE_RES);
      expect(filled.sort()).toEqual([...hole].sort());
    }
  });

  it('REFUSES a hole above the cap, whole', () => {
    // 7 cells, one over. The refusal is total — see noiseHoles' own comment
    // on why a partial fill is worse than none.
    const hole = gridDisk(centre, 1);
    expect(hole).toHaveLength(7);
    expect(noiseHoles(punch(hole), DEFAULT_TILE_RES)).toEqual([]);
  });

  it('never partially fills — a big hole contributes nothing, not its first six cells', () => {
    // The 342-cell hole in the real 2026-09-09 measurement was 12 hectares.
    // Claiming an arbitrary sliver of it would leave a ragged edge inside a
    // city block.
    const big = gridDisk(centre, 3); // 37 cells
    expect(noiseHoles(punch(big), DEFAULT_TILE_RES)).toEqual([]);
  });

  it('fills the small holes and leaves the big one, in the same shape', () => {
    // The real mixed case: a runner's coverage has both.
    const small = [latLngToCell(25.6866, -100.3161, DEFAULT_TILE_RES)];
    const bigCentre = gridDisk(centre, 6).find(
      (c) => !gridDisk(centre, 4).includes(c),
    )!;
    const big = gridDisk(bigCentre, 2); // 19 cells
    const wide = gridDisk(centre, 12);
    const gone = new Set([...small, ...big]);
    const filled = noiseHoles(
      wide.filter((c) => !gone.has(c)),
      DEFAULT_TILE_RES,
    );
    expect(filled).toContain(small[0]);
    for (const cell of big) expect(filled).not.toContain(cell);
  });

  it('encloses nothing from an open path — same guarantee as enclosedCells', () => {
    // A line has no interior, so there is no hole to be under the cap. This
    // is the property that makes the 3.3 km auto-close exploit yield zero,
    // and the cap must not create a new way around it.
    const line = Array.from({ length: 40 }, (_, i) =>
      latLngToCell(25.6866 + i * 0.0004, -100.3161, DEFAULT_TILE_RES),
    );
    expect(noiseHoles(line, DEFAULT_TILE_RES)).toEqual([]);
  });

  it('returns nothing for input too small to enclose anything', () => {
    expect(noiseHoles([], DEFAULT_TILE_RES)).toEqual([]);
    expect(noiseHoles([centre], DEFAULT_TILE_RES)).toEqual([]);
  });

  it('is a subset of what enclosedCells finds', () => {
    // The cap only ever REMOVES candidates. If this ever fails, noiseHoles
    // has found ground enclosure itself would not claim, which would be a
    // new way to invent territory.
    const hole = gridDisk(centre, 1).slice(0, 3);
    const cells = punch(hole);
    const all = new Set(enclosedCells(cells, DEFAULT_TILE_RES));
    for (const cell of noiseHoles(cells, DEFAULT_TILE_RES)) {
      expect(all.has(cell)).toBe(true);
    }
  });

  it('respects an explicit cap', () => {
    const hole = gridDisk(centre, 1).slice(0, 3);
    expect(noiseHoles(punch(hole), DEFAULT_TILE_RES, 2)).toEqual([]);
    expect(noiseHoles(punch(hole), DEFAULT_TILE_RES, 3).sort()).toEqual([...hole].sort());
  });

  it('MAX_NOISE_HOLE_CELLS sits inside the gap the real data showed', () => {
    // Measured 2026-09-09: nothing between 3 cells (56 m) and 9 cells
    // (110 m). A cap outside that band is a different decision and needs a
    // fresh `npm run measure-holes`, not a guess.
    expect(MAX_NOISE_HOLE_CELLS).toBeGreaterThanOrEqual(3);
    expect(MAX_NOISE_HOLE_CELLS).toBeLessThan(9);
  });
});
