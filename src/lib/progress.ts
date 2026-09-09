// Park-path progress per municipio — the personal record of where a runner
// has actually been, shown in the Saved tab.
//
// This file used to be areas.ts and carried Board 2: user-created `areas`
// that a runner closed a loop around and was asked to NAME, becoming that
// area's Legend. All of it is gone — "why are we naming loops and shit" —
// and Board 2's mechanic now lives in mayorship.ts over the H3 grid instead,
// where nothing has to be declared, drawn or named. See that file's header.
//
// What survived is this, which was never about areas: it counts VISITS as a
// personal record, not a contest. Board 1's own park-path percentage is a
// deliberately different number (ownership, in leaderboard.ts's
// districtConquest) and the two will disagree for the same runner. Neither
// is wrong — see districtConquest's header.
import { supabase } from '@/lib/supabase';
import { withSession } from '@/lib/territory-sync';

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
