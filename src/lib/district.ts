// The ARENA — the piece of ground a leaderboard is a claim about.
//
// This replaces the leaderboard's old region/global pill pair, and it is a
// deliberate rejection of administrative boundaries. The reasoning is
// measured, not aesthetic.
//
// WHY NOT THE MUNICIPIO, which is what was asked for first. Nothing in this
// app can resolve a lat/lng to a municipio: `regions.ts` is METRO-level
// (Monterrey is one region spanning seven municipios) and no boundary
// polygons are stored anywhere. The cheap substitute — truncate the 36,193
// stored park-path cells to a coarse H3 parent and read the municipio off
// that — was measured and does not work: at res 7, 21.3% of parent cells
// straddle two municipios, and at res 6, 50.0%. Monterrey's municipios
// interlock too tightly. A runner standing in San Nicolás would routinely be
// told they are competing in Monterrey. Real boundaries would fix it, at the
// price of an Overpass pass, a PostGIS table, a hand-applied migration and a
// round trip on every location change — and they would still only cover the
// municipios somebody extracted.
//
// WHY AN H3 CELL. It is what the games that actually solved this do: Pokémon
// GO and Ingress never reverse-geocode to administrative regions at all —
// their S2 grid IS the region, and gyms, nests and regional scoring are all
// cell-indexed. CityStrides and Wandrer take the other road (OSM admin
// boundaries) and pay a PostGIS table per city plus a server round trip for
// it. Foursquare's mayorship, which this app's second board is modelled on,
// needs a venue database — which is the naming this product has rejected.
//
// So: `latLngToCell(lat, lng, DISTRICT_RES)` is exactly where you are.
// Computed locally in microseconds, offline, with no table, no migration, no
// round trip, no ambiguity by construction, anywhere on Earth, at zero
// marginal cost. The 21% ambiguity above is entirely an artifact of forcing
// the grid onto administrative lines; drop the lines and it disappears.
//
// The cost of this choice, stated plainly: a district has no human name. That
// is what `districtLabel` is for, and the label is DECORATIVE — nothing
// ranks, filters or scores by it. See its own comment.
import { cellToParent, getResolution, latLngToCell } from 'h3-js';

import type { LatLng } from '@/lib/territory';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

/**
 * The arena's resolution. res 7 is ~5.16 km², about 2.8 km across —
 * MEASURED with getHexagonAreaAvg rather than recalled, because this repo
 * has already been burned by remembered H3 areas (see the backlog's "the ask
 * was 15x smaller, which DOES NOT EXIST").
 *
 * Chosen for contestability, which is the only thing that matters here: a
 * 5 km run crosses a res-7 district, so one session can plausibly change who
 * leads it. The neighbours are both wrong for that —
 *
 *   res 6: 36.13 km², 7.46 km across. Too big to move; a good run barely
 *          dents it, which is the same "years or never" failure the park-path
 *          denominator was chosen to avoid (see park_paths.sql).
 *   res 8:  0.74 km², 1.07 km across. Too small to be a fight — you would
 *          hold your own street outright and never meet anyone.
 *
 * H3 steps by a factor of 7 in area per resolution, so there is nothing
 * between these. Do not go looking for an intermediate size.
 */
export const DISTRICT_RES = 7;

/** The district a position is in. This is the whole lookup — no network, no
 *  table, no boundary test. */
export function districtOf(at: LatLng): string {
  return latLngToCell(at.lat, at.lng, DISTRICT_RES);
}

/**
 * The district a claimed/visited cell belongs to.
 *
 * H3 ids are hierarchical, so this is pure truncation — the same property the
 * backlog already verified in SQL ("cells 500 m apart share a res-6
 * ancestor, Monterrey and CDMX do not"). No geometry is computed.
 *
 * Returns null for a cell that is not at the tile resolution, rather than
 * guessing. Stored res-11 cells still exist from before the res-12
 * conversion, and `cellToParent` would happily return a parent for one —
 * which would quietly mix two resolutions into one district's totals. An
 * unconverted tile must read as "not counted", never as territory.
 */
export function districtOfCell(h3: string): string | null {
  if (getResolution(h3) !== DEFAULT_TILE_RES) return null;
  return cellToParent(h3, DISTRICT_RES);
}

/** True when a tile-resolution cell sits inside the given district. */
export function isInDistrict(h3: string, district: string): boolean {
  return districtOfCell(h3) === district;
}

/**
 * A human label for a district, by majority vote over the park-path cells
 * inside it — "San Pedro Garza García" rather than `872d8a2b1ffffff`.
 *
 * DECORATIVE, and that is not a hedge — it is what makes the majority vote
 * acceptable. The measurement in this file's header (21.3% of res-7 parents
 * straddle two municipios) is exactly the error this vote inherits, so a
 * district on a municipal boundary WILL sometimes be labelled with the
 * neighbour's name. That is survivable for a caption and would not be for a
 * score, which is why nothing ranks, filters, scores or claims by this
 * value: the district id does all of that.
 *
 * Returns null when no park cells fall inside — most of the planet. Callers
 * must render the map instead of inventing a name; the shape on screen is
 * the identity, which is the same reason this product stopped asking runners
 * to name their loops.
 */
export function districtLabel(
  district: string,
  parkCells: { h3: string; municipio: string }[],
): string | null {
  const votes = new Map<string, number>();
  for (const cell of parkCells) {
    if (districtOfCell(cell.h3) !== district) continue;
    votes.set(cell.municipio, (votes.get(cell.municipio) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [municipio, count] of votes) {
    // Strictly greater, plus a name tie-break, so the label is STABLE across
    // loads. A Map's iteration order follows insertion, which follows
    // whatever order the rows arrived in — without the tie-break an exact
    // 50/50 district would flip its caption between two fetches for no
    // visible reason.
    if (count > bestCount || (count === bestCount && best !== null && municipio < best)) {
      best = municipio;
      bestCount = count;
    }
  }
  return best;
}
