// The leaderboard's district-scoped read.
//
// Filters SERVER-SIDE by the district's H3 prefix (districtCellPattern)
// rather than pulling a table down and truncating every id on device — this
// repo has already shipped a leaderboard that silently ranked a truncated
// 1000-row sample (see fetchTileLeaderboard's own paging comment).
//
// NEEDS NO MIGRATION, which is the point. `tile_visits` already has a `read
// all` policy, opened when the table was created for exactly this ("other
// runners' tile_visits eventually for the Layer 2 rolling board"). Migrations
// here are applied BY HAND and an unapplied one reads as an honest zero, so
// a board that needs no SQL cannot be broken by forgetting to run any.
//
// A park-path read lived here too and is DELETED. It fed a denominator this
// board no longer uses (see ConquestEntry.share) and a caption now taken from
// the metro region — and it never returned anything anyway: park_path_cells
// is empty in production and all four live districts contain zero park cells.
import { districtCellPattern } from '@/lib/district';
import type { TileVisitRow } from '@/lib/mayorship';
import { supabase } from '@/lib/supabase';
import { withSession, type Outcome } from '@/lib/territory-sync';

/** PostgREST's hard page size. Paged rather than assumed — see this file's
 *  header for what happened the last time a read here assumed. */
const PAGE = 1000;

/**
 * The district's visits: Board 2's raw material.
 *
 * Everyone's, not just this device's — mayorship is a contest, so the whole
 * district's visits are needed to decide who holds each cell. The window is
 * applied CLIENT-SIDE in mayorByCell rather than as a `gte` here, on purpose:
 * one function owns what "inside the window" means, so the fetch and the
 * ranking can never disagree about it, and MAYORSHIP_WINDOW_DAYS stays a
 * single constant to tune.
 *
 * Ceiling, stated because it will arrive: tile_visits grows by roughly the
 * number of cells a run touches directly (~160 for a 3 km run — visits, not
 * enclosure). The district prefix keeps this proportional to one arena rather
 * than the whole table, and `tile_visits` has no index usable by a prefix
 * LIKE (its indexes are on user_id and run_id), so this is a sequential scan.
 * Fine at 1,745 rows; when it is not, the fix is an RPC that returns
 * mayorship per cell, not more paging here.
 */
export async function fetchDistrictVisits(
  district: string,
): Promise<Outcome<{ visits: TileVisitRow[] }>> {
  return withSession<{ visits: TileVisitRow[] }>(async () => {
    const pattern = `${districtCellPattern(district)}%`;
    const rows: { h3: string; user_id: string; visited_at: string }[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('tile_visits')
        .select('h3, user_id, visited_at')
        .like('h3', pattern)
        // (h3, run_id) is the primary key; h3 alone is not unique, so the
        // second key makes paging deterministic.
        .order('h3', { ascending: true })
        .order('run_id', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error || !data) return { ok: false, reason: 'network' as const };
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    // Names in one follow-up query keyed on the distinct users present,
    // rather than a PostgREST embed: tile_visits has no FK to profiles (it
    // references auth.users), so there is no relationship for PostgREST to
    // resolve. Same shape as fetchTileLeaderboard's own profile lookup.
    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
    const nameById = new Map<string, string | null>();
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds);
      // A failed name lookup leaves every displayName null, which renders as
      // "Anonymous". The mayorship itself is unaffected — the count is the
      // point, the name is a garnish.
      if (profiles) for (const p of profiles) nameById.set(p.id, p.display_name ?? null);
    }

    return {
      ok: true,
      visits: rows.map((r) => ({
        h3: r.h3,
        userId: r.user_id,
        displayName: nameById.get(r.user_id) ?? null,
        visitedAt: r.visited_at,
      })),
    };
  });
}
