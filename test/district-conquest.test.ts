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
  it('scores each runner as a share of the CLAIMED ground', () => {
    const result = districtConquest(
      [tile(cell(0), 'u1'), tile(cell(1), 'u1'), tile(cell(2), 'u2')],
      DISTRICT,
    );
    expect(result.claimedTotal).toBe(3);
    expect(result.entries[0]).toMatchObject({ userId: 'u1', cellsHeld: 2 });
    expect(result.entries[0].share).toBeCloseTo(2 / 3, 10);
    expect(result.entries[1].share).toBeCloseTo(1 / 3, 10);
    // Every claimed cell has exactly one holder, so the shares sum to 1 —
    // which is what lets the bar render with no remainder.
    expect(result.entries.reduce((sum, e) => sum + e.share, 0)).toBeCloseTo(1, 10);
  });

  it('gives a lone runner the whole of what is claimed, not a rounding error', () => {
    // The measured failure of the previous denominator: against the
    // district's 16 807 cells every real runner sat between 0.02% and 2.39%
    // and nothing they did moved it.
    const result = districtConquest([tile(cell(0), 'u1'), tile(cell(1), 'u1')], DISTRICT);
    expect(result.entries[0].share).toBe(1);
  });

  it('reports the frontier separately, against the whole district', () => {
    // A different question with a different denominator. Small is the honest
    // answer here and the point — it is how much is left to take.
    const result = districtConquest([tile(cell(0), 'u1')], DISTRICT);
    expect(result.districtTotal).toBe(cellToChildrenSize(DISTRICT, DEFAULT_TILE_RES));
    expect(result.districtTotal).toBe(16807);
    expect(result.claimedTotal / result.districtTotal).toBeCloseTo(1 / 16807, 10);
  });

  it('never emits NaN or Infinity, including on an empty district', () => {
    const empty = districtConquest([], DISTRICT);
    expect(empty.entries).toEqual([]);
    expect(empty.claimedTotal).toBe(0);
    expect(empty.districtTotal).toBeGreaterThan(0);
    const one = districtConquest([tile(cell(0), 'u1')], DISTRICT);
    expect(Number.isFinite(one.entries[0].share)).toBe(true);
  });

  it('excludes cells from other districts', () => {
    const result = districtConquest(
      [tile(cell(0), 'local'), tile(farCell(0), 'distant'), tile(farCell(1), 'distant')],
      DISTRICT,
    );
    expect(result.entries.map((e) => e.userId)).toEqual(['local']);
    expect(result.claimedTotal).toBe(1);
  });

  it('excludes an unconverted res-11 tile rather than inflating a district', () => {
    const oldCell = latLngToCell(MTY.lat, MTY.lng, 11);
    const result = districtConquest([tile(cell(0), 'u1'), tile(oldCell, 'u1')], DISTRICT);
    expect(result.entries[0].cellsHeld).toBe(1);
    expect(result.claimedTotal).toBe(1);
  });

  it('ranks by ground held, matching the share that is shown', () => {
    const result = districtConquest(
      [tile(cell(0), 'small'), tile(cell(1), 'big'), tile(cell(2), 'big')],
      DISTRICT,
    );
    expect(result.entries.map((e) => e.userId)).toEqual(['big', 'small']);
    expect(result.entries[0].share).toBeGreaterThan(result.entries[1].share);
  });

  it('counts flagged claims and says so, rather than excluding them', () => {
    // Same "marked, not punished" posture as every other board here: a GPS
    // glitch must never silently cost someone their score.
    const result = districtConquest([tile(cell(0), 'u1'), tile(cell(1), 'u1', true)], DISTRICT);
    expect(result.entries[0].cellsHeld).toBe(2);
    expect(result.entries[0].flaggedCellsHeld).toBe(1);
  });

  it('fills a display name from any row that has one', () => {
    const result = districtConquest(
      [
        { h3: cell(0), ownerId: 'u1', displayName: null, regionId: 'mty', flagged: false },
        { h3: cell(1), ownerId: 'u1', displayName: 'Daniel', regionId: 'mty', flagged: false },
      ],
      DISTRICT,
    );
    expect(result.entries[0].displayName).toBe('Daniel');
  });

  it('is a total order — equal scores never reshuffle between loads', () => {
    const rows = [tile(cell(0), 'bbb'), tile(cell(1), 'aaa')];
    const first = districtConquest(rows, DISTRICT).entries.map((e) => e.userId);
    const second = districtConquest([...rows].reverse(), DISTRICT).entries.map((e) => e.userId);
    expect(first).toEqual(second);
    expect(first).toEqual(['aaa', 'bbb']);
  });
});
