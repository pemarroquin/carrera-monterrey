// Board 1 — conquest as a share of the district's park paths.
//
// The case that matters most here is `hasDenominator`. A district with no
// park data must NOT render as 0%: that would tell a runner who just covered
// their whole neighbourhood that they hold none of it. Everywhere outside
// the seven extracted Nuevo León municipios is that case.
import { cellToChildrenSize, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { districtOf } from '../src/lib/district';
import { districtConquest, type TileOwnerRow } from '../src/lib/leaderboard';
import { DEFAULT_TILE_RES } from '../src/lib/tiles';

const MTY = { lat: 25.6866, lng: -100.3161 };
const DISTRICT = districtOf(MTY);

/** A distinct res-12 cell inside DISTRICT. */
function cell(n: number): string {
  return latLngToCell(MTY.lat + n * 0.0004, MTY.lng, DEFAULT_TILE_RES);
}
/** A res-12 cell ~20 km away, so a different district. */
function farCell(n: number): string {
  return latLngToCell(MTY.lat + n * 0.0004, MTY.lng + 0.2, DEFAULT_TILE_RES);
}

function tile(h3: string, ownerId: string, flagged = false): TileOwnerRow {
  return { h3, ownerId, displayName: null, regionId: 'mty', flagged };
}

describe('districtConquest', () => {
  it('scores share as owned park cells over the district total', () => {
    const parkCells = new Set([cell(0), cell(1), cell(2), cell(3)]);
    const result = districtConquest(
      [tile(cell(0), 'u1'), tile(cell(1), 'u1'), tile(cell(2), 'u2')],
      DISTRICT,
      parkCells,
    );
    expect(result.basis).toBe('parkPaths');
    expect(result.cellTotal).toBe(4);
    expect(result.entries[0]).toMatchObject({ userId: 'u1', countedCells: 2, share: 0.5 });
    expect(result.entries[1]).toMatchObject({ userId: 'u2', countedCells: 1, share: 0.25 });
  });

  it('counts non-park ground in cellsHeld but never in a park share', () => {
    // A runner who covers streets rather than parks is not invisible — the
    // percentage alone would hide them entirely.
    const result = districtConquest(
      [tile(cell(0), 'u1'), tile(cell(5), 'u1'), tile(cell(6), 'u1')],
      DISTRICT,
      new Set([cell(0)]),
    );
    expect(result.entries[0].cellsHeld).toBe(3);
    expect(result.entries[0].countedCells).toBe(1);
    expect(result.entries[0].share).toBe(1);
  });

  it('falls back to the DISTRICT as denominator when there is no park data', () => {
    // The case that is universal today: park_path_cells is empty in
    // production, so every real district lands here. It must still be a
    // percentage — a raw count in its place made the headline number stop
    // being a share at all, which is what this file's subject forbids.
    const result = districtConquest([tile(cell(0), 'u1'), tile(cell(1), 'u1')], DISTRICT, new Set());
    expect(result.basis).toBe('district');
    // Every res-12 cell in a res-7 arena. Asserted, not assumed.
    expect(result.cellTotal).toBe(cellToChildrenSize(DISTRICT, DEFAULT_TILE_RES));
    expect(result.cellTotal).toBe(16807);
    expect(result.entries[0].share).toBeCloseTo(2 / 16807, 10);
    expect(result.entries[0].cellsHeld).toBe(2);
  });

  it('never emits NaN or Infinity, on either basis', () => {
    for (const parks of [new Set<string>(), new Set([cell(0)])]) {
      const result = districtConquest([tile(cell(0), 'u1')], DISTRICT, parks);
      expect(Number.isFinite(result.entries[0].share)).toBe(true);
      expect(result.cellTotal).toBeGreaterThan(0);
    }
  });

  it('excludes cells from other districts', () => {
    const result = districtConquest(
      [tile(cell(0), 'local'), tile(farCell(0), 'distant'), tile(farCell(1), 'distant')],
      DISTRICT,
      new Set([cell(0)]),
    );
    expect(result.entries.map((e) => e.userId)).toEqual(['local']);
  });

  it('excludes an unconverted res-11 tile rather than inflating a district', () => {
    const oldCell = latLngToCell(MTY.lat, MTY.lng, 11);
    const result = districtConquest(
      [tile(cell(0), 'u1'), tile(oldCell, 'u1')],
      DISTRICT,
      new Set([cell(0)]),
    );
    expect(result.entries[0].cellsHeld).toBe(1);
  });

  it('ranks by the number actually shown, on either basis', () => {
    const noParks = districtConquest(
      [tile(cell(0), 'small'), tile(cell(1), 'big'), tile(cell(2), 'big')],
      DISTRICT,
      new Set(),
    );
    expect(noParks.entries.map((e) => e.userId)).toEqual(['big', 'small']);

    // With parks, the ranking follows PARK cells, not total ground: 'parky'
    // holds fewer cells but more of the thing being measured.
    const withParks = districtConquest(
      [
        tile(cell(0), 'parky'),
        tile(cell(5), 'streety'),
        tile(cell(6), 'streety'),
        tile(cell(7), 'streety'),
      ],
      DISTRICT,
      new Set([cell(0)]),
    );
    expect(withParks.entries.map((e) => e.userId)).toEqual(['parky', 'streety']);
  });

  it('counts flagged claims and says so, rather than excluding them', () => {
    // Same "marked, not punished" posture as every other board here: a GPS
    // glitch must never silently cost someone their score.
    const result = districtConquest(
      [tile(cell(0), 'u1'), tile(cell(1), 'u1', true)],
      DISTRICT,
      new Set([cell(0), cell(1)]),
    );
    expect(result.entries[0].cellsHeld).toBe(2);
    expect(result.entries[0].flaggedCellsHeld).toBe(1);
    expect(result.entries[0].share).toBe(1);
  });

  it('fills a display name from any row that has one', () => {
    const result = districtConquest(
      [
        { h3: cell(0), ownerId: 'u1', displayName: null, regionId: 'mty', flagged: false },
        { h3: cell(1), ownerId: 'u1', displayName: 'Daniel', regionId: 'mty', flagged: false },
      ],
      DISTRICT,
      new Set(),
    );
    expect(result.entries[0].displayName).toBe('Daniel');
  });

  it('is a total order — equal scores never reshuffle between loads', () => {
    const rows = [tile(cell(0), 'bbb'), tile(cell(1), 'aaa')];
    const first = districtConquest(rows, DISTRICT, new Set()).entries.map((e) => e.userId);
    const second = districtConquest([...rows].reverse(), DISTRICT, new Set()).entries.map(
      (e) => e.userId,
    );
    expect(first).toEqual(second);
    expect(first).toEqual(['aaa', 'bbb']);
  });

  it('returns an empty board rather than throwing when nobody holds anything', () => {
    const result = districtConquest([], DISTRICT, new Set([cell(0)]));
    expect(result.entries).toEqual([]);
    expect(result.basis).toBe('parkPaths');
  });
});
