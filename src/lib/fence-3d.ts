// Splitting a live route into its settled part and its live edge.
//
// While a session is running the route renders in two pieces: the last
// FENCE_LAG_M metres stay a flat gradient line (the "live" edge, still being
// drawn), and everything older than that is already territory.
//
// The two share their join point, so the line feeds into the ground behind
// it rather than leaving a gap.
//
// This file used to also build a ribbon polygon along the path, extruded to
// read as a wall. That is gone: the wall is now the TILE footprint
// (track-map.web.tsx), because a ribbon is one self-intersecting ring
// wherever a runner doubles back, and Mapbox triangulates it into
// overlapping triangles that blend against each other — the same street run
// twice drew twice as dark. Tiles cannot overlap, so they cannot stack.
//
// Pure functions with no map/SDK dependency, so the metre maths is unit
// testable — same reasoning as territory.ts.
import { haversineM, type LatLng } from '@/lib/territory';

export interface RouteSplit {
  /** Older part of the route — the ground already claimed behind the
   *  runner. */
  settled: LatLng[];
  /** Most recent stretch — stays a flat line. Shares its first point with
   *  `settled`'s last, so the two render as one continuous route. */
  active: LatLng[];
}

/**
 * Splits a route into the part that has "set" into a fence and the live
 * trailing edge, measured by distance travelled backwards from the current
 * position — not by point count, which would vary with GPS sample rate.
 */
export function splitTrailing(points: LatLng[], trailingM: number): RouteSplit {
  if (points.length < 2) return { settled: [], active: points };

  let accumulated = 0;
  // Walk backwards from the newest point until `trailingM` is covered.
  for (let i = points.length - 1; i > 0; i--) {
    accumulated += haversineM(points[i - 1], points[i]);
    if (accumulated >= trailingM) {
      // `accumulated` INCLUDES the i-1 → i segment, so the live edge has to
      // start at i-1 for its length to actually equal that distance. Slicing
      // from `i` here left the edge one segment short of the window — caught
      // by the "covers at least the requested window" test.
      return {
        settled: points.slice(0, i), // ends at points[i - 1]
        active: points.slice(i - 1), // starts at points[i - 1] — shared join
      };
    }
  }
  // Whole route is shorter than the trailing window: nothing has settled yet.
  return { settled: [], active: points };
}
