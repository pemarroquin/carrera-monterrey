// Enclosure: the ground a runner surrounds. The safety properties matter as
// much as the happy path here — the enclosure model was tried once before in
// this app and produced a 977,565 m² fence from a 3.3 km one-way run, so the
// cases proving that CANNOT happen again are the point of this file.
import { gridDisk, gridRingUnsafe, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { enclosedCells } from '@/lib/enclosure';
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
