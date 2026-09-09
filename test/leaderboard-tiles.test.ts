// Tile Coverage Model — count-based leaderboard ranking (brief §6 step 6).
// Separate file from leaderboard.test.ts, which covers the OLD
// rankByArea/unionAreaM2 pipeline (still exported, still tested — brief §4:
// don't delete). This file exercises the new rankByTileCount instead: a
// plain per-owner count over territory_tiles rows, no turf, no union — see
// leaderboard.ts's own "Tile Coverage Model" section header for why that's
// possible under first-to-claim (one tile has exactly one owner, ever).
import { describe, expect, it } from 'vitest';

import { latLngToCell } from 'h3-js';

import { rankByTileCount, type TileOwnerRow } from '../src/lib/leaderboard';

// A DISTINCT, real res-12 cell per row. territory_tiles' primary key is h3,
// so two rows can never share one — a helper that handed out the same id
// would let a test assert something the database cannot produce. Walks east
// in ~40 m steps, comfortably more than one res-12 cell (~10.8 m edge).
let cellSeq = 0;
function nextCell(): string {
  cellSeq++;
  return latLngToCell(25.6866, -100.3161 + cellSeq * 0.0004, 12);
}

function tile(
  ownerId: string,
  regionId: string | null = 'mty',
  displayName: string | null = null,
  flagged = false,
  h3: string = nextCell(),
): TileOwnerRow {
  return { h3, ownerId, displayName, regionId, flagged };
}

describe('rankByTileCount', () => {
  it('ranks by tile count, descending', () => {
    const ranked = rankByTileCount(
      [tile('u1'), tile('u2'), tile('u2'), tile('u2')],
      null,
    );
    expect(ranked.map((e) => e.userId)).toEqual(['u2', 'u1']);
    expect(ranked[0].tileCount).toBe(3);
    expect(ranked[1].tileCount).toBe(1);
  });

  it('never double-counts — each row is one distinct tile by construction', () => {
    // Unlike the old union pipeline, there is no "same ground counted
    // twice" case to guard against here: territory_tiles has exactly one
    // row per h3 (the PRIMARY KEY), so summing rows IS the correct count.
    // This test exists mainly to document that this simplification is
    // intentional, not an oversight of the union pipeline's whole reason
    // for existing.
    const ranked = rankByTileCount([tile('u1'), tile('u1'), tile('u1')], null);
    expect(ranked[0].tileCount).toBe(3);
  });

  it('filters to one region, dropping users with nothing there', () => {
    const ranked = rankByTileCount([tile('u1', 'mty'), tile('u2', 'cdmx')], 'mty');
    expect(ranked.map((e) => e.userId)).toEqual(['u1']);
  });

  it('includes every region when regionId is null', () => {
    const ranked = rankByTileCount([tile('u1', 'mty'), tile('u2', 'cdmx')], null);
    expect(ranked).toHaveLength(2);
  });

  it('excludes untagged tiles from a regional board but keeps them globally', () => {
    const tiles = [tile('u1', null)];
    expect(rankByTileCount(tiles, 'mty')).toHaveLength(0);
    expect(rankByTileCount(tiles, null)).toHaveLength(1);
  });

  it('prefers a set display name over a null from a partial join', () => {
    const ranked = rankByTileCount(
      [tile('u1', 'mty', null), tile('u1', 'mty', 'Pedro')],
      null,
    );
    expect(ranked[0].displayName).toBe('Pedro');
  });

  it('orders ties stably by user id rather than reshuffling between loads', () => {
    const tiles = [tile('zzz'), tile('aaa')];
    expect(rankByTileCount(tiles, null).map((e) => e.userId)).toEqual(
      rankByTileCount([...tiles].reverse(), null).map((e) => e.userId),
    );
  });

  it('counts flagged tiles per user without excluding them from the score', () => {
    // Same "counts, but marked" posture as the old flaggedCount — a tile
    // claimed by a flagged run still counts toward tileCount.
    const clean = rankByTileCount([tile('u1')], null)[0];
    const flagged = rankByTileCount([tile('u1', 'mty', null, true)], null)[0];
    expect(clean.tileCount).toBe(1);
    expect(flagged.tileCount).toBe(1);
    expect(clean.flaggedTileCount).toBe(0);
    expect(flagged.flaggedTileCount).toBe(1);
  });

  it('counts only the flagged subset of a user’s tiles', () => {
    const entry = rankByTileCount(
      [tile('u1'), tile('u1', 'mty', null, true), tile('u1', 'mty', null, true)],
      null,
    )[0];
    expect(entry.tileCount).toBe(3);
    expect(entry.flaggedTileCount).toBe(2);
  });

  it('is empty for no tiles', () => {
    expect(rankByTileCount([], null)).toEqual([]);
  });
});
