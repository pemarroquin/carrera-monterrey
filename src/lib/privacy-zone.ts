// Privacy zones — keeps the start and end of a run away from where you live
// before anything is uploaded.
//
// THE PROBLEM. Territory Mode uploads a GPS path and a fence polygon to a
// database whose read policy is open (`runs: read all`) and whose anon key
// ships inside the app bundle. Anyone who has the app can read every run.
// If you start and finish at your front door, that door is in the data.
//
// WHY THE HOME POINT NEVER LEAVES THE DEVICE. The feature plan suggested
// storing it in `profiles.home_point`, which already exists in the schema —
// but `profiles` carries `for select using (true)`, so writing a home point
// there would publish every user's address to every other user. That is
// strictly worse than the problem being solved. So the home point lives in
// local prefs (db.ts) and the masking happens HERE, client-side, before
// upload. The column stays empty; 0002 drops it so nobody fills it later.
//
// WHY THE RADIUS IS RANDOMISED. This is the part that is easy to get wrong.
// Clipping at a FIXED radius R puts the first surviving point of every run
// on a circle of radius R centred on your home. Three runs give three points
// on that circle, and three points determine a circle — so a fixed radius
// hands an attacker the exact centre. This is not hypothetical; it is how
// Strava's privacy zones were defeated in published work. Randomising the
// cut per run scatters the endpoints across an annulus instead, which has no
// unique centre to solve for.
//
// WHY THE FENCE ISN'T CLIPPED DIRECTLY. Cutting a circular bite out of the
// finished polygon would draw a literal circle around the house — the
// clearest possible signal. Instead the PATH is trimmed and the fence is
// rebuilt from the trimmed path: buildFence auto-closes any shape, so the
// boundary near home becomes an ordinary straight chord, indistinguishable
// from someone who simply ran a slightly different loop.
import { haversineM, type LatLng } from '@/lib/territory';
import type { TrackPoint } from '@/lib/tracking';

/** Default zone radius in metres — Pedro's call, 2026-08-27. */
export const DEFAULT_ZONE_RADIUS_M = 200;

/**
 * How much the cut distance may exceed the radius, as a fraction. At the
 * 200m default the real cut lands somewhere in 200–350m, so endpoints from
 * repeated runs spread over a 150m-wide band rather than a single circle.
 */
export const ZONE_JITTER_FRACTION = 0.75;

export interface PrivacyZone {
  home: LatLng;
  radiusM: number;
}

export interface MaskResult {
  /** The path safe to upload. Empty if the whole run was inside the zone. */
  points: TrackPoint[];
  /** Points removed from the start. */
  trimmedStart: number;
  /** Points removed from the end. */
  trimmedEnd: number;
  /** True when masking changed anything — drives the UI's "masked" note. */
  masked: boolean;
  /** True when the ENTIRE run fell inside the zone, so nothing can be
   *  uploaded without revealing the home area. Caller must not upload. */
  fullyInsideZone: boolean;
  /**
   * The jittered cut distance actually used for THIS run, metres, or null
   * when no zone is set.
   *
   * Exposed for enclosure (enclosure.ts): a loop that starts and ends at
   * home encloses ground around the home, and those cells have to be
   * dropped before upload. They must be dropped at THIS cut, not at the
   * nominal radius — a fixed-radius bite out of the claimed area puts a
   * circle of known radius around the home on every run, and three of them
   * determine its centre. That is the exact attack the jitter above exists
   * to defeat, and it would be reintroduced by the claimed tiles even
   * though the uploaded path was masked correctly.
   */
  cutM: number | null;
}

/**
 * Cut distance for one run: the radius plus a random margin. Takes an
 * optional `random` so tests can pin it — never seeded from the run itself,
 * because a value derived from start time or position would be reproducible
 * by anyone holding the uploaded data, which defeats the whole point.
 */
export function jitteredRadius(radiusM: number, random: () => number = Math.random): number {
  return radiusM * (1 + random() * ZONE_JITTER_FRACTION);
}

/**
 * Trims both ends of a recorded path back to outside the (jittered) zone.
 *
 * Trimming is by DISTANCE FROM HOME, not by a fixed point count: a runner
 * warming up slowly near the house produces many closely-spaced fixes, and
 * dropping "the first N points" would leave them well inside the zone.
 */
export function maskPath(
  points: TrackPoint[],
  zone: PrivacyZone | null,
  random: () => number = Math.random,
): MaskResult {
  if (!zone || points.length === 0) {
    return {
      points,
      trimmedStart: 0,
      trimmedEnd: 0,
      masked: false,
      fullyInsideZone: false,
      cutM: null,
    };
  }

  // One draw per run, applied to both ends. Two independent draws would make
  // the start and end cuts differ, which leaks slightly more shape.
  const cut = jitteredRadius(zone.radiusM, random);
  const outside = (p: LatLng) => haversineM(zone.home, p) > cut;

  let start = 0;
  while (start < points.length && !outside(points[start])) start++;

  // Nothing survived: the whole run happened inside the zone.
  if (start >= points.length) {
    return {
      points: [],
      trimmedStart: points.length,
      trimmedEnd: 0,
      masked: true,
      fullyInsideZone: true,
      cutM: cut,
    };
  }

  let end = points.length - 1;
  while (end > start && !outside(points[end])) end--;

  const trimmed = points.slice(start, end + 1);
  return {
    points: trimmed,
    trimmedStart: start,
    trimmedEnd: points.length - 1 - end,
    masked: start > 0 || end < points.length - 1,
    fullyInsideZone: false,
    cutM: cut,
  };
}

/** Whether a point falls inside the zone at its nominal radius — used to
 *  warn BEFORE a run that it will be masked, where jitter is irrelevant. */
export function isInsideZone(point: LatLng, zone: PrivacyZone | null): boolean {
  if (!zone) return false;
  return haversineM(zone.home, point) <= zone.radiusM;
}
