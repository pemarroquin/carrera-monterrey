// Areas and Local Legends — Board 2.
//
// Board 1 (territory, territory-sync.ts) answers "who holds the most ground
// right now". It rewards big loops and recency, and one huge Sunday run can
// top it. This board answers a different question — "who actually shows up
// here" — and the two are deliberately not comparable.
//
// The split exists because three attempts to protect the regular runner
// INSIDE the ownership rules each made the map worse (see the backlog spec's
// recorded corrections; the worst produced donuts, where a big loop took the
// middle of a park out of a runner's daily ring). Ownership stays simple;
// fairness for regulars lives here instead. Strava reached the same shape:
// KOM is the all-time champion, Local Legend counts showing up.
import { supabase } from '@/lib/supabase';
import { withSession } from '@/lib/territory-sync';

/** Trailing window for the Legend title, in days. Foursquare's mayorship
 *  uses 30 and it is a period a runner can actually feel — long enough that
 *  one week off does not erase you, short enough that the title has to be
 *  defended. */
export const LEGEND_WINDOW_DAYS = 30;

/** An area's name, as stored. Matches the DB's own CHECK, so a name that
 *  would be rejected server-side is caught before the round trip. */
export const AREA_NAME_MAX = 40;

export interface Area {
  id: string;
  name: string;
  createdBy: string;
  regionId: string | null;
  cellCount: number;
}

export interface LegendRow {
  userId: string;
  /** Days present in the window. ONE per day however far they ran that day —
   *  the cap is the mechanic, see the migration's own reasoning. */
  days: number;
  /** Earliest day they showed up inside the window. The tie-break: equal
   *  days go to whoever has been at it longer. */
  firstDay: string;
  displayName: string | null;
}

export type AreaOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'invalidName' };

/**
 * Every area whose ground this run touched, ranked. Pure — the caller does
 * the fetching, this only decides ordering and shape, so it is testable
 * without a database (this suite has no renderer and no Postgres).
 *
 * Ordering mirrors the SQL exactly: days descending, then earliest first day.
 * Duplicated deliberately rather than trusting the server's order — a client
 * that re-sorts differently from the server would show one runner as Legend
 * on the board and another in a detail view, which is worse than either
 * being wrong on its own.
 */
export function rankLegends(rows: LegendRow[]): LegendRow[] {
  return [...rows].sort((a, b) => (b.days - a.days) || a.firstDay.localeCompare(b.firstDay));
}

/**
 * Whether a name may be used for a new area. Names are permanent and public
 * — there is no update policy on the table — so this is the only chance to
 * reject one.
 */
export function isValidAreaName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= AREA_NAME_MAX;
}

/**
 * Creates a public area from ground a run covered, and returns it.
 *
 * The cells come from a run rather than from a drawing tool: an area IS
 * somewhere a person actually ran, which means it is real ground at a real
 * scale, and it costs no map-drawing UI. It is public from the moment it
 * exists, which is the condition that makes the Legend title mean anything
 * — an area only its creator knows about is one they win forever
 * uncontested.
 *
 * Not transactional across the two inserts: if the cells fail to write, an
 * empty area row is left behind. That reads as an area nobody can ever score
 * on, which is inert rather than wrong, and is preferable to the alternative
 * (cells belonging to no area, which the FK would reject anyway).
 */
export async function createArea(
  name: string,
  cells: string[],
  regionId: string | null,
): Promise<AreaOutcome<{ area: Area }>> {
  if (!isValidAreaName(name)) return { ok: false, reason: 'invalidName' };

  return withSession<{ area: Area }, 'invalidName'>(async (session) => {
    const trimmed = name.trim();
    const unique = [...new Set(cells)];

    const { data, error } = await supabase
      .from('areas')
      .insert({
        name: trimmed,
        created_by: session.user.id,
        region_id: regionId,
        cell_count: unique.length,
      })
      .select('id, name, created_by, region_id, cell_count')
      .single();
    if (error || !data) return { ok: false, reason: 'network' };

    if (unique.length > 0) {
      const { error: cellError } = await supabase
        .from('area_cells')
        .insert(unique.map((h3) => ({ area_id: data.id, h3 })));
      if (cellError) return { ok: false, reason: 'network' };
    }

    return {
      ok: true,
      area: {
        id: data.id,
        name: data.name,
        createdBy: data.created_by,
        regionId: data.region_id,
        cellCount: data.cell_count,
      },
    };
  });
}

/** Areas in a region, for the board's list. Region rather than a spatial
 *  query for the same reason territory_tiles carries region_id: this app has
 *  a coarse metro string already and no need for PostGIS here. */
export async function fetchAreas(regionId: string | null): Promise<AreaOutcome<{ areas: Area[] }>> {
  return withSession<{ areas: Area[] }>(async () => {
    let query = supabase.from('areas').select('id, name, created_by, region_id, cell_count');
    if (regionId !== null) query = query.eq('region_id', regionId);

    const { data, error } = await query;
    if (error || !data) return { ok: false, reason: 'network' };
    return {
      ok: true,
      areas: data.map((a) => ({
        id: a.id,
        name: a.name,
        createdBy: a.created_by,
        regionId: a.region_id,
        cellCount: a.cell_count,
      })),
    };
  });
}

/**
 * The Legend board for one area.
 *
 * Two round trips, not a join: `tile_visits.user_id` references auth.users
 * directly rather than profiles, so PostgREST cannot embed the display name
 * — the same limitation fetchTileLeaderboard already works around, and the
 * same fallback applies (a failed name read leaves every name null and the
 * UI shows "anonymous"; the RANKING is unaffected, and the ranking is the
 * point).
 */
export async function fetchLegends(
  areaId: string,
  windowDays: number = LEGEND_WINDOW_DAYS,
): Promise<AreaOutcome<{ legends: LegendRow[] }>> {
  return withSession<{ legends: LegendRow[] }>(async () => {
    const { data, error } = await supabase.rpc('area_legends', {
      p_area_id: areaId,
      p_days: windowDays,
    });
    if (error || !data) return { ok: false, reason: 'network' };

    const rows = data as { user_id: string; days: number; first_day: string }[];
    const ids = [...new Set(rows.map((r) => r.user_id))];

    let nameById = new Map<string, string | null>();
    if (ids.length > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', ids);
      if (profiles) nameById = new Map(profiles.map((p) => [p.id, p.display_name ?? null]));
    }

    return {
      ok: true,
      legends: rankLegends(
        rows.map((r) => ({
          userId: r.user_id,
          days: r.days,
          firstDay: r.first_day,
          displayName: nameById.get(r.user_id) ?? null,
        })),
      ),
    };
  });
}
