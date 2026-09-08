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
  /** ISO timestamp. Needed by the client only to decide whether to OFFER
   *  deletion — see canDeleteArea. The policy is the actual rule. */
  createdAt: string;
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
      .select('id, name, created_by, created_at, region_id, cell_count')
      .single();
    if (error || !data) return { ok: false, reason: 'network' };

    // Chunked for the same reason claimTiles' rival lookup is: a run can
    // cover hundreds of cells, and one oversized insert is a single failure
    // point for the whole area.
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const { error: cellError } = await supabase
        .from('area_cells')
        .insert(unique.slice(i, i + CHUNK).map((h3) => ({ area_id: data.id, h3 })));
      if (cellError) {
        // The area row is already in. There is no delete policy on `areas`
        // (deliberate — an area's shape must not be editable by a losing
        // incumbent), so it cannot be cleaned up from here. Report the
        // failure honestly rather than returning ok with a half-built area:
        // its cell_count would advertise ground it does not contain, and it
        // could never be scored on.
        return { ok: false, reason: 'network' };
      }
    }

    return {
      ok: true,
      area: {
        id: data.id,
        name: data.name,
        createdBy: data.created_by,
        createdAt: data.created_at,
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
    let query = supabase.from('areas').select('id, name, created_by, created_at, region_id, cell_count');
    if (regionId !== null) query = query.eq('region_id', regionId);

    const { data, error } = await query;
    if (error || !data) return { ok: false, reason: 'network' };
    return {
      ok: true,
      areas: data.map((a) => ({
        id: a.id,
        name: a.name,
        createdBy: a.created_by,
        createdAt: a.created_at,
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

/**
 * How long after creating an area its creator may still remove it. Must match
 * the window in the RLS policy (20260908040000) — the database is the rule,
 * this constant only decides whether the UI offers the button.
 *
 * One hour separates the two cases it has to tell apart: a typo or a test is
 * noticed within minutes, while abandoning a contested area happens days
 * later, once someone else starts winning it.
 */
export const AREA_DELETE_WINDOW_MS = 60 * 60 * 1000;

/** Whether `createdAt` is still inside that window. Pure, so the UI can ask
 *  without a round trip; the policy decides for real. */
export function canDeleteArea(createdAt: string, now: number = Date.now()): boolean {
  return now - new Date(createdAt).getTime() < AREA_DELETE_WINDOW_MS;
}

/**
 * Removes an area the caller just created. `area_cells` goes with it via ON
 * DELETE CASCADE.
 *
 * Returns 'denied' rather than a bare failure when nothing was deleted. RLS
 * makes a DELETE that matches no policy a silent no-op returning success —
 * the exact trap `runs: delete own` sat in for weeks — so this checks the
 * returned row count instead of trusting the absence of an error.
 */
export type DeleteAreaOutcome =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'denied' };

export async function deleteArea(areaId: string): Promise<DeleteAreaOutcome> {
  return withSession<{ deleted: true }, 'denied'>(async () => {
    const { data, error } = await supabase.from('areas').delete().eq('id', areaId).select('id');
    if (error) return { ok: false, reason: 'network' };
    if (!data || data.length === 0) return { ok: false, reason: 'denied' };
    return { ok: true, deleted: true };
  });
}

/**
 * How much of a PROPOSED area must already be covered by an existing one
 * before the app suggests competing there instead.
 *
 * Measured against the proposal, not symmetrically, and the asymmetry is the
 * point. "Most of the ground you just marked already belongs to an area" is
 * the question worth asking. The reverse — a small existing area sitting
 * inside a much larger proposal — is not a duplicate: someone marking a
 * whole neighbourhood loop that happens to contain a park is describing a
 * different thing, and should be allowed to.
 *
 * 0.6 rather than something near 1.0 because two people tracing the same
 * park never produce the same cells: they enter at different gates, run the
 * path in different directions, and their GPS wanders differently. Demanding
 * near-identity would catch almost none of the duplicates this exists to
 * prevent.
 */
export const AREA_OVERLAP_SUGGEST = 0.6;

export interface AreaOverlap {
  areaId: string;
  name: string;
  /** Cells shared with the proposed area. */
  shared: number;
  /** Total cells in the existing area. */
  areaCellCount: number;
  /** Share of the PROPOSED area already covered by this one, 0..1. */
  coverage: number;
}

/**
 * The best existing match for a proposed cell set, or null if nothing
 * substantially overlaps.
 *
 * Pure, so the threshold is testable without a database — the SQL returns
 * raw counts precisely so this judgement lives here.
 */
export function bestOverlap(rows: AreaOverlap[], threshold: number = AREA_OVERLAP_SUGGEST): AreaOverlap | null {
  const candidates = rows.filter((r) => r.coverage >= threshold);
  if (candidates.length === 0) return null;
  // Highest coverage wins; ties go to the SMALLER area, which is the more
  // specific description of the same ground — "Parque El Capitán" rather
  // than "the whole west side".
  return candidates.reduce((best, r) =>
    r.coverage > best.coverage || (r.coverage === best.coverage && r.areaCellCount < best.areaCellCount)
      ? r
      : best,
  );
}

/**
 * Existing areas overlapping a proposed cell set.
 *
 * Note what "joining" costs the runner: nothing. Anyone whose run touches an
 * area is ranked on it automatically, so if they accept the suggestion there
 * is no action to take — they are already competing there. The prompt exists
 * only to stop a duplicate being created.
 *
 * A failure here returns no overlaps rather than an error. Being unable to
 * check must not block someone naming their loop; the worst case is one
 * duplicate area, which is the situation this feature improves on, not a
 * regression from it.
 */
export async function findOverlappingAreas(cells: string[]): Promise<AreaOverlap[]> {
  if (cells.length === 0) return [];
  const { data, error } = await supabase.rpc('area_overlaps', { p_cells: cells });
  if (error || !data) return [];

  const rows = data as { area_id: string; name: string; shared: number; area_cell_count: number }[];
  return rows.map((r) => ({
    areaId: r.area_id,
    name: r.name,
    shared: r.shared,
    areaCellCount: r.area_cell_count,
    coverage: cells.length > 0 ? r.shared / cells.length : 0,
  }));
}

export interface MunicipioProgress {
  municipio: string;
  /** Park-path cells this runner has covered. */
  covered: number;
  /** Park-path cells in the municipio — the denominator. */
  total: number;
  /** Kilometres of runnable path inside its parks. */
  pathKm: number;
  parks: number;
}

export type ProgressOutcome =
  | { ok: true; municipios: MunicipioProgress[] }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Park-path progress per municipio.
 *
 * WHY PARK PATHS and not the municipio's area or its whole street network —
 * measured, not chosen for taste. One 5.7 km run in San Pedro Garza García
 * is 0.262% of the municipio's AREA, 0.63% of its full street network, and
 * 5.5% of its park paths. Only the last is a bar that moves; the others are
 * years or never. See the backlog spec.
 *
 * COUNTS VISITS, NOT ENCLOSURE — enforced server-side in municipio_progress.
 * Enclosure is how territory is won; this is the record of where the runner
 * actually went, so running a park's perimeter must not credit paths inside
 * it that were never run.
 *
 * Returns every municipio with data loaded, including ones never run. A
 * progress screen that hides the zeroes cannot show anyone where they have
 * not been yet, which is most of the point.
 */
export async function fetchMunicipioProgress(): Promise<ProgressOutcome> {
  return withSession<{ municipios: MunicipioProgress[] }>(async () => {
    const { data, error } = await supabase.rpc('municipio_progress');
    if (error || !data) return { ok: false, reason: 'network' };
    const rows = data as {
      municipio: string;
      covered: number;
      total: number;
      path_km: string | number;
      parks: number;
    }[];
    return {
      ok: true,
      municipios: rows.map((r) => ({
        municipio: r.municipio,
        covered: r.covered,
        total: r.total,
        // numeric comes back as a string over PostgREST.
        pathKm: Number(r.path_km),
        parks: r.parks,
      })),
    };
  });
}
