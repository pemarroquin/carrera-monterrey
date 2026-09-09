// Phase 2 — leaderboard aggregation. Pure functions over rows already
// fetched, so the ranking maths is unit-testable without a network or a
// database, same philosophy as territory.ts and races.ts.
//
// WHY THIS IS CLIENT-SIDE, not the `ST_Union ... group by user_id` query in
// the feature plan: PostgREST can't express that aggregate, so it would need
// a Postgres function — and migrations in this project are applied BY HAND
// (see CLAUDE.md). An unapplied one fails silently and reads as "nobody has
// any territory", which is indistinguishable from an empty board. Turf is
// already a dependency and the union pipeline already exists here, so this
// path works the moment a run is saved, with no setup step that can be
// forgotten.
//
// The union is NOT optional and summing `area_m2` is not a shortcut: running
// the same loop twice would otherwise count that ground twice. Overlapping
// runs by one user collapse into the area actually held — which is the whole
// definition of the score.
//
// Ceiling: this fetches every fence geometry to aggregate them on device.
// Fine at friends scale (tens of runs); if the board ever gets slow, the fix
// is the `profile_stats` table in the plan (a trigger unions just the one
// user's rows per insert, so write cost stays flat) — at which point this
// file becomes a fallback rather than the primary path.
import area from '@turf/area';
import { featureCollection } from '@turf/helpers';
import union from '@turf/union';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

import { cellToChildrenSize } from 'h3-js';

import { districtOfCell } from '@/lib/district';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

export interface LeaderboardRun {
  userId: string;
  displayName: string | null;
  region: string | null;
  geometry: Polygon | MultiPolygon;
  /** Server-side speed flag. Flagged runs still count toward the ranking —
   *  the board marks them rather than excluding them, so a GPS glitch never
   *  silently costs someone their score. */
  flagged?: boolean;
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string | null;
  /** Area actually held — overlapping runs by this user counted once. */
  areaM2: number;
  runCount: number;
  /** How many of those runs the speed trigger flagged. Surfaced so a board
   *  built partly on implausible runs says so, rather than presenting every
   *  row as equally solid. */
  flaggedCount: number;
}

function asFeature(geometry: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return { type: 'Feature', properties: {}, geometry };
}

/**
 * Total area held by one user: the union of all their fences, measured once.
 *
 * Falls back to the largest single fence if turf's union fails outright —
 * a degenerate ring can make it return null, and reporting a smaller-but-real
 * number beats reporting a 0 that looks like "this user has no territory".
 */
export function unionAreaM2(geometries: (Polygon | MultiPolygon)[]): number {
  if (geometries.length === 0) return 0;
  if (geometries.length === 1) return area(asFeature(geometries[0]));

  try {
    const merged = union(featureCollection(geometries.map(asFeature)));
    if (merged) return area(merged);
  } catch {
    // Fall through to the per-fence maximum below.
  }
  return Math.max(...geometries.map((g) => area(asFeature(g))));
}

/**
 * Rank users by area held, descending. `regionId` narrows to runs tagged
 * with that region (set at insert time by territory-sync.ts); pass null for
 * the global board.
 *
 * A user whose runs are all outside the selected region drops off entirely
 * rather than appearing with 0 — a regional board is a claim about that
 * metro, and a 0-area row there says something false.
 */
export function rankByArea(
  runs: LeaderboardRun[],
  regionId: string | null,
): LeaderboardEntry[] {
  const byUser = new Map<string, LeaderboardRun[]>();
  for (const run of runs) {
    if (regionId !== null && run.region !== regionId) continue;
    const existing = byUser.get(run.userId);
    if (existing) existing.push(run);
    else byUser.set(run.userId, [run]);
  }

  const entries: LeaderboardEntry[] = [];
  for (const [userId, userRuns] of byUser) {
    entries.push({
      userId,
      // Any row's name will do — they all come from the same profile row —
      // but prefer a set one over a null in case of a partial join.
      displayName: userRuns.find((r) => r.displayName !== null)?.displayName ?? null,
      areaM2: unionAreaM2(userRuns.map((r) => r.geometry)),
      runCount: userRuns.length,
      flaggedCount: userRuns.filter((r) => r.flagged === true).length,
    });
  }

  // Ties broken by run count then id, so the order is stable between loads
  // rather than reshuffling on every refresh.
  entries.sort(
    (a, b) =>
      b.areaM2 - a.areaM2 || b.runCount - a.runCount || a.userId.localeCompare(b.userId),
  );
  return entries;
}

/** Which regions actually have runs, for the region picker. */
export function regionsWithRuns(runs: LeaderboardRun[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) if (run.region !== null) seen.add(run.region);
  return Array.from(seen).sort();
}

// ============================================================================
// Tile Coverage Model — count-based ranking (Tile Coverage brief §6 step 6)
// ============================================================================
//
// rankByArea/unionAreaM2 above are UNCHANGED and still exported — the brief
// §4 is explicit ("do not delete anything in this commit"): land tiles
// alongside the old model, prove it on a real run, then remove. This is the
// new path leaderboard.tsx actually renders; the union pipeline above is now
// dead code kept for audit/comparison until that removal happens.
//
// Why this is simpler than the union pipeline it replaces, not just newer:
// one tile has exactly one owner AT A TIME. It is no longer forever —
// conquest (20260908010000) lets a later run take a tile — but ownership is
// still single-valued at any moment, which is all the ranking needs.
// Ranking is therefore a plain count of
// territory_tiles rows per owner, no turf, no polygon union, no "did these
// two fences overlap" question at all — the DB schema itself already
// answers "who owns this ground" per tile.

/** One row of `territory_tiles`, already joined to its owner's display name
 *  and the flagged status of the run that claimed it — see
 *  territory-sync.ts's fetchTileLeaderboard for how this is assembled. */
export interface TileOwnerRow {
  /** The cell itself. Was fetched and discarded before districtConquest
   *  needed it — the district filter and the map both key off it. */
  h3: string;
  ownerId: string;
  displayName: string | null;
  regionId: string | null;
  /** The §2.5 forgery guard rejects wholesale fabrication before a claim
   *  ever lands here — this is the OTHER guard, flag_implausible_speed,
   *  carried over from the run that claimed this specific tile. A flagged
   *  claim still counts (same "marked, not punished" posture as the old
   *  leaderboard), the row just says so. */
  flagged: boolean;
}

// rankByTileCount and TileLeaderboardEntry lived here and are DELETED, not
// deprecated: districtConquest replaced them outright when the leaderboard
// stopped ranking by a raw tile count over a whole metro. Nothing imported
// them any more — the two remaining mentions in this repo are comments.
//
// Not deleted alongside them, deliberately: rankByArea / unionAreaM2 /
// regionsWithRuns above. Those were already dead before this change (the
// tile-coverage model replaced them) and a prior brief explicitly said to
// keep them and their ~30 tests through that migration. Removing them is a
// separate decision and not this branch's to make.


// ============================================================================
// BOARD 1 — CONQUEST, as a share of the district's park paths
// ============================================================================
//
// What the board shows changed from a raw tile count to a PERCENTAGE, at
// Pedro's ask: "% of parks conquered in the municipio I'm located at,
// period." Two substitutions were needed to deliver that, and both are
// deliberate:
//
//   municipio -> DISTRICT. Nothing can resolve a lat/lng to a municipio and
//   the cheap substitute measured 21.3% ambiguous. See district.ts's header
//   for the full reasoning and the games precedent.
//
//   "parks" -> PARK PATHS, which is the denominator park_paths.sql already
//   measured as the only one that moves: one 5.7 km run is 0.262% of San
//   Pedro's area, 0.63% of its street network, and 5.5% of its park paths.
//
// CONQUERED, NOT VISITED — and this is the one place where this board and
// the `municipio_progress` RPC that shipped the same week deliberately
// disagree. That RPC counts visits, on purpose, because it is a personal
// record of where someone went. This is a contest over ground, so it counts
// what a runner OWNS: territory_tiles.owner_id. The two numbers will differ
// for the same runner (enclosure can hand you park paths you never set foot
// on) and neither is wrong.
//
// Zero migrations, which is why it is here rather than in SQL: every tile's
// h3 + owner_id is already fetched by fetchTileLeaderboard, and park cells
// are H3-keyed, so the whole thing is a set intersection on data in memory.
// Migrations in this project are applied BY HAND and an unapplied one reads
// as an honest zero (see CLAUDE.md, and the backlog's own warnings) — a
// leaderboard that says 0% because nobody ran the SQL is indistinguishable
// from one that says 0% because nobody ran.

export interface ConquestEntry {
  userId: string;
  displayName: string | null;
  /**
   * This runner's share of the CLAIMED ground in the district, 0-1.
   *
   * Share of claimed, not share of the district, and that was measured. A
   * res-7 district holds 16 807 res-12 cells and most of them are buildings,
   * private land or water — ground nobody can run. Against that denominator
   * every real runner sits between 0.02% and 2.39% (measured across all four
   * live districts, 2026-09-09) and no amount of running moves it. That is
   * precisely the "years or never" denominator park_paths.sql measured and
   * rejected — 0.262% of a municipio's area for a 5.7 km run — and an
   * earlier version of this file reproduced it.
   *
   * Against claimed ground the same runs read 8.6% to 91.4%: 58.5% against
   * 41.5% is a contest, 85% against 15% is a rout you can see. That is the
   * question a leaderboard asks — who holds this place — and it is inherently
   * relative. It also moves the moment anyone runs, in both directions,
   * which is what makes it worth defending.
   */
  share: number;
  /** Cells this runner owns in the district. The absolute number, kept
   *  because a share alone cannot distinguish holding half of a busy
   *  district from holding half of an empty one. */
  cellsHeld: number;
  flaggedCellsHeld: number;
}

export interface DistrictConquest {
  entries: ConquestEntry[];
  /** Cells owned by anyone in this district — the shares' denominator. */
  claimedTotal: number;
  /** Every res-12 cell in the arena: 16 807, always, anywhere on Earth, with
   *  no data at all. Not a share denominator (see ConquestEntry.share) — it
   *  is what the FRONTIER is measured against: how much of this district has
   *  been claimed by anyone yet. Small is the honest answer there, and the
   *  point: it is how much is left to take. */
  districtTotal: number;
}

/**
 * Board 1 for one district — who holds the claimed ground.
 *
 * Pure, over rows already fetched. Ties broken by user id for a stable order
 * between loads, same reasoning as the rest of this file.
 */
export function districtConquest(tiles: TileOwnerRow[], district: string): DistrictConquest {
  const byUser = new Map<
    string,
    { displayName: string | null; cellsHeld: number; flaggedCellsHeld: number }
  >();

  let claimedTotal = 0;
  for (const tile of tiles) {
    // districtOfCell also rejects any cell not at the tile resolution, so an
    // unconverted res-11 tile is excluded rather than inflating a district.
    if (districtOfCell(tile.h3) !== district) continue;
    claimedTotal++;
    let entry = byUser.get(tile.ownerId);
    if (!entry) {
      entry = { displayName: tile.displayName, cellsHeld: 0, flaggedCellsHeld: 0 };
      byUser.set(tile.ownerId, entry);
    }
    entry.cellsHeld++;
    if (tile.flagged) entry.flaggedCellsHeld++;
    if (entry.displayName === null && tile.displayName !== null) {
      entry.displayName = tile.displayName;
    }
  }

  const entries: ConquestEntry[] = [...byUser.entries()]
    .map(([userId, agg]) => ({
      userId,
      displayName: agg.displayName,
      // claimedTotal is 0 only when byUser is empty, so this never divides by
      // zero — but it is written defensively anyway, because a NaN reaching
      // the UI would render as "NaN%" rather than fail.
      share: claimedTotal > 0 ? agg.cellsHeld / claimedTotal : 0,
      cellsHeld: agg.cellsHeld,
      flaggedCellsHeld: agg.flaggedCellsHeld,
    }))
    .sort(
      (a, b) =>
        b.cellsHeld - a.cellsHeld || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );

  return { entries, claimedTotal, districtTotal: cellToChildrenSize(district, DEFAULT_TILE_RES) };
}
