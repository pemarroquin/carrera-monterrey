// Board 1 — conquest as a share of the district's park paths.
//
// The case that matters most here is `hasDenominator`. A district with no
// park data must NOT render as 0%: that would tell a runner who just covered
// their whole neighbourhood that they hold none of it. Everywhere outside
// the seven extracted Nuevo León municipios is that case.
import { latLngToCell } from 'h3-js';
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
    expect(result.hasDenominator).toBe(true);
    expect(result.parkCellTotal).toBe(4);
    expect(result.entries[0]).toMatchObject({ userId: 'u1', parkCellsHeld: 2, share: 0.5 });
    expect(result.entries[1]).toMatchObject({ userId: 'u2', parkCellsHeld: 1, share: 0.25 });
  });

  it('counts non-park ground in cellsHeld but never in share', () => {
    // A runner who covers streets rather than parks is not invisible — the
    // percentage alone would hide them entirely.
    const parkCells = new Set([cell(0)]);
    const result = districtConquest(
      [tile(cell(0), 'u1'), tile(cell(5), 'u1'), tile(cell(6), 'u1')],
      DISTRICT,
      parkCells,
    );
    expect(result.entries[0].cellsHeld).toBe(3);
    expect(result.entries[0].parkCellsHeld).toBe(1);
    expect(result.entries[0].share).toBe(1);
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

  it('flags a district with NO park data instead of reporting 0%', () => {
    // The important one. 0/0 rendered as "0%" is a lie about the runner's
    // ground; callers branch on hasDenominator and show cells held.
    const result = districtConquest([tile(cell(0), 'u1'), tile(cell(1), 'u1')], DISTRICT, new Set());
    expect(result.hasDenominator).toBe(false);
    expect(result.parkCellTotal).toBe(0);
    expect(result.entries[0].share).toBe(0);
    // The honest number is still there.
    expect(result.entries[0].cellsHeld).toBe(2);
    // And no NaN or Infinity ever reaches the UI.
    expect(Number.isFinite(result.entries[0].share)).toBe(true);
  });

  it('ranks by cells held when there is no denominator, matching what is shown', () => {
    const result = districtConquest(
      [tile(cell(0), 'small'), tile(cell(1), 'big'), tile(cell(2), 'big')],
      DISTRICT,
      new Set(),
    );
    expect(result.entries.map((e) => e.userId)).toEqual(['big', 'small']);
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
    expect(result.hasDenominator).toBe(true);
  });
});
