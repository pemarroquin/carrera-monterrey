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

export interface TileLeaderboardEntry {
  userId: string;
  displayName: string | null;
  /** Tiles this user currently owns — Layer 1's "permanent progression"
   *  number (brief §1.5). Not a percentage: that needs §1's real
   *  municipio/runnable-tile denominator, explicitly out of scope this
   *  pass — see index.tsx and the executor's report. */
  tileCount: number;
  /** How many of tileCount came from a run the speed trigger flagged. */
  flaggedTileCount: number;
}

/**
 * Ranks users by tiles owned, descending. `regionId` narrows to tiles
 * claimed by a run tagged with that region (the SAME coarse metro string as
 * rankByArea's `regionId` param — see TileOwnerRow.regionId's own doc);
 * pass null for the global board. Ties broken by user id for a stable order
 * between loads, same reasoning as rankByArea.
 *
 * A user with zero tiles in the selected region drops off entirely, same
 * "a regional board is a claim about that metro" reasoning as rankByArea.
 */
export function rankByTileCount(
  tiles: TileOwnerRow[],
  regionId: string | null,
): TileLeaderboardEntry[] {
  const byUser = new Map<
    string,
    { displayName: string | null; tileCount: number; flaggedTileCount: number }
  >();
  for (const tile of tiles) {
    if (regionId !== null && tile.regionId !== regionId) continue;
    const existing = byUser.get(tile.ownerId);
    if (existing) {
      existing.tileCount++;
      if (tile.flagged) existing.flaggedTileCount++;
      // Any row's name will do (they all come from the same profile row) —
      // fill in a set one over a null in case of a partial join, same as
      // rankByArea.
      if (existing.displayName === null && tile.displayName !== null) {
        existing.displayName = tile.displayName;
      }
    } else {
      byUser.set(tile.ownerId, {
        displayName: tile.displayName,
        tileCount: 1,
        flaggedTileCount: tile.flagged ? 1 : 0,
      });
    }
  }

  const entries: TileLeaderboardEntry[] = [];
  for (const [userId, v] of byUser) {
    entries.push({ userId, ...v });
  }
  entries.sort((a, b) => b.tileCount - a.tileCount || a.userId.localeCompare(b.userId));
  return entries;
}

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
  /** Cells counted toward this runner's share — park-path cells under the
   *  'parkPaths' basis, all owned cells in the district under 'district'. */
  countedCells: number;
  /** Share of the district, 0-1. ALWAYS meaningful — see ConquestBasis. */
  share: number;
  /** Every owned cell in the district, park or not. Kept alongside the share
   *  because the percentage alone hides a runner who covers streets rather
   *  than parks. */
  cellsHeld: number;
  flaggedCellsHeld: number;
}

/**
 * What the percentage is a share OF.
 *
 * 'parkPaths' is the denominator park_paths.sql measured as the only one that
 * moves: one 5.7 km run is 0.262% of San Pedro's area, 0.63% of its street
 * network, and 5.5% of its park paths.
 *
 * 'district' is every res-12 cell in the arena — 16 807 of them, always,
 * anywhere on Earth, with no data at all. It exists because the park
 * denominator DOES NOT EXIST in practice: `park_path_cells` is empty in
 * production (measured 2026-09-09; the 36,193-row data migration is applied
 * by hand and never was), so every real district falls here today.
 *
 * The previous version returned `hasDenominator: false` and let the caller
 * fall back to a raw cell count, which meant the headline number silently
 * stopped being a percentage. That is precisely what this file's own header
 * forbids — "a leaderboard that says 0% because nobody ran the SQL is
 * indistinguishable from one that says 0% because nobody ran". A share of
 * the district is always defined and upgrades to the park share the moment
 * the data lands.
 *
 * It counts ground nobody can run (buildings, private land), which is fine:
 * it is the same denominator for everyone in the district, so the contest is
 * fair, and the numbers move — 402 cells is 2.4%.
 */
export type ConquestBasis = 'parkPaths' | 'district';

export interface DistrictConquest {
  entries: ConquestEntry[];
  /** The denominator actually used. */
  cellTotal: number;
  basis: ConquestBasis;
}

/**
 * Board 1 for one district.
 *
 * `parkCells` is the district's park-path cell set (see fetchDistrictParkCells)
 * — passed in rather than fetched so this stays pure and testable. Empty is a
 * valid input and selects the 'district' basis.
 *
 * Ties broken by user id for a stable order between loads, same reasoning as
 * rankByTileCount.
 */
export function districtConquest(
  tiles: TileOwnerRow[],
  district: string,
  parkCells: Set<string>,
): DistrictConquest {
  const basis: ConquestBasis = parkCells.size > 0 ? 'parkPaths' : 'district';
  const cellTotal = basis === 'parkPaths' ? parkCells.size : cellToChildrenSize(district, DEFAULT_TILE_RES);

  const byUser = new Map<
    string,
    { displayName: string | null; countedCells: number; cellsHeld: number; flaggedCellsHeld: number }
  >();

  for (const tile of tiles) {
    // districtOfCell also rejects any cell not at the tile resolution, so an
    // unconverted res-11 tile is excluded here rather than being counted
    // into a district it would inflate.
    if (districtOfCell(tile.h3) !== district) continue;
    let entry = byUser.get(tile.ownerId);
    if (!entry) {
      entry = { displayName: tile.displayName, countedCells: 0, cellsHeld: 0, flaggedCellsHeld: 0 };
      byUser.set(tile.ownerId, entry);
    }
    entry.cellsHeld++;
    if (tile.flagged) entry.flaggedCellsHeld++;
    if (basis === 'district' || parkCells.has(tile.h3)) entry.countedCells++;
    if (entry.displayName === null && tile.displayName !== null) {
      entry.displayName = tile.displayName;
    }
  }

  const entries: ConquestEntry[] = [...byUser.entries()]
    .map(([userId, agg]) => ({
      userId,
      displayName: agg.displayName,
      countedCells: agg.countedCells,
      // cellTotal cannot be 0: cellToChildrenSize is 16 807 for any res-7
      // cell, and the parkPaths branch is only taken when the set is
      // non-empty. So no NaN or Infinity can reach the UI.
      share: agg.countedCells / cellTotal,
      cellsHeld: agg.cellsHeld,
      flaggedCellsHeld: agg.flaggedCellsHeld,
    }))
    // Ranked by the number actually shown, so the ordering always matches it.
    .sort(
      (a, b) =>
        b.countedCells - a.countedCells ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );

  return { entries, cellTotal, basis };
}
