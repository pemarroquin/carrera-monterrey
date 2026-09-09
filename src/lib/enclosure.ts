// Enclosure — the ground a runner surrounds, as opposed to the ground they
// physically cover (tiles.ts). Owner's call, 2026-09-07: "a loop around a
// park earns you the perimeter and everything inside it."
//
// This is the Qix / Paper.io mechanic, expressed on the H3 grid the app
// already scores on rather than on polygon area. That distinction is the
// whole safety argument, because the enclosure model was ALREADY TRIED here
// and abandoned: a 3.3 km one-way run auto-closed into a 977,565 m² fence
// (see supabase/migrations/20260903120000_tile_coverage.sql and the
// anti-cheat evidence doc). What made that possible was AUTO-CLOSING —
// joining two endpoints the runner never connected. Nothing here does that:
//
//   - The only input is the set of cells the runner actually covered. A
//     hole exists only where their own cells form a closed ring around it.
//   - An open path encloses nothing. The 3.3 km exploit yields zero.
//   - A gap in the loop LEAKS. If a background interruption left a hole in
//     the ring, the region is no longer enclosed and nothing is claimed —
//     so "never connect across a gap" stops being a rule this code has to
//     remember and becomes a property of the geometry. See gap-policy.ts.
//
// ONLY YOUR OWN TILES ARE WALLS. This function is given one runner's cells
// and nothing else, so a rival's tiles can never serve as part of your
// boundary — you cannot enclose a neighbourhood by using someone else's run
// as three of its four sides. That rule is satisfied by construction rather
// than by a check, which is why there is no rival parameter here.
//
// Pure — no React, no network. Same testing philosophy as tiles.ts.
import { cellToLatLng, cellsToMultiPolygon, polygonToCells } from 'h3-js';

import { haversineM, type LatLng } from '@/lib/territory';

/**
 * The cells enclosed by `cells` but not among them.
 *
 * Works off H3's own dissolve: cellsToMultiPolygon merges a cell set into
 * outlines, and an enclosed empty region comes back as a HOLE in one of
 * those outlines (ring index 1+). Filling each hole with polygonToCells
 * yields exactly the interior — verified against gridRing/gridDisk in
 * enclosure.test.ts, where the interior of a radius-3 ring is precisely
 * gridDisk(2).
 *
 * Deliberately NOT a flood fill from a bounding box. Both give the same
 * answer, but the bbox version has to enumerate every cell in the
 * rectangle around the run — tens of thousands for a long loop, most of
 * them outside it — while this only ever touches the enclosed region
 * itself.
 *
 * Returns [] when nothing is enclosed, which is the common case: an
 * out-and-back, a point-to-point run, or a loop that never closed.
 */
/**
 * Every region this cell set surrounds, ONE ARRAY PER HOLE.
 *
 * The single place the dissolve → hole-ring → fill pipeline is written.
 * `enclosedCells` and `noiseHoles` are both thin wrappers over it, and
 * `npm run measure-holes` reports on it, so there is no second copy to
 * drift. That is not a style preference here: gap-policy.ts exists only
 * because the recorder and the tile builder each applied the caps
 * themselves and disagreed about one real gap, and verify-claims.ts runs
 * the app's own functions for the same reason.
 *
 * Kept as one array PER HOLE rather than one flat set because the size of
 * an individual hole is a decision input — see noiseHoles' cap. Callers that
 * do not care flatten it.
 *
 * GeoJSON winding ([lng, lat]) from both h3 calls, so the rings handed to
 * polygonToCells are already in the order it expects.
 */
export function holesOf(cells: string[], res: number): string[][] {
  // Two cells cannot surround anything; skip the dissolve entirely.
  if (cells.length < 3) return [];

  const owned = new Set(cells);
  const holes: string[][] = [];

  for (const polygon of cellsToMultiPolygon(cells, true)) {
    // Ring 0 is the outer boundary; every ring after it is a hole — an empty
    // region this cell set surrounds.
    for (let ring = 1; ring < polygon.length; ring++) {
      // polygonToCells fills by cell centre, so a cell of the ring itself can
      // be picked up when the hole's edge runs through it. Claiming it again
      // would be harmless but double-counts in every total.
      const hole = polygonToCells([polygon[ring]], res, true).filter((c) => !owned.has(c));
      if (hole.length > 0) holes.push(hole);
    }
  }

  return holes;
}

export function enclosedCells(cells: string[], res: number): string[] {
  // Deduplicated across holes: two rings of one dissolved shape cannot
  // normally share a cell, but a Set costs nothing and a double-counted cell
  // would inflate every total that reads this.
  return [...new Set(holesOf(cells, res).flat())];
}

/**
 * Drops enclosed cells that fall inside the privacy zone, at the cut
 * distance THIS run actually used.
 *
 * Needed because enclosure is computed from the UNMASKED path. It has to
 * be: masking trims 200-350 m off each end, which for a runner who starts
 * and finishes at home is exactly the section that closes the loop — so an
 * enclosure computed from the masked path would find no loop at all, and
 * home loops (most runs) would never enclose anything.
 *
 * Computing it unmasked and filtering afterwards keeps the full path on the
 * device while still not shipping the home area. `cutM` MUST be the value
 * maskPath used for this same run, never the nominal radius: a bite of
 * fixed radius taken out of every run's claimed area puts a circle of known
 * size around the home, and three runs determine its centre — the attack
 * privacy-zone.ts's jitter exists to defeat. Passing the nominal radius
 * here would mask the path correctly and then leak the home through the
 * tiles instead.
 *
 * Cells are judged by their CENTRE. A cell straddling the boundary is kept
 * only if its centre is outside, which at res 12 puts the worst-case
 * overshoot at about half a tile (~5 m) against a cut of 200 m or more.
 */
export function dropCellsInsideZone(cells: string[], home: LatLng | null, cutM: number | null): string[] {
  if (!home || cutM === null) return cells;
  return cells.filter((cell) => {
    const [lat, lng] = cellToLatLng(cell);
    return haversineM(home, { lat, lng }) > cutM;
  });
}

/**
 * The largest hole, in cells, that counts as a GAP IN SAMPLING rather than
 * as ground the runner went around.
 *
 * MEASURED, not chosen. `npm run measure-holes` read every runner's real
 * coverage on 2026-09-09 and the distribution is cleanly bimodal:
 *
 *     29 holes of 1 cell   ( 20 m wide,     362 m²)
 *      9 holes of 2 cells  ( 41 m wide,     724 m²)
 *      1 hole  of 3 cells  ( 56 m wide,   1 085 m²)
 *     ---------------------------------------------- nothing at all here
 *        holes of 9, 10, 11, 20, 32, 33, 93, 124, 317, 342 cells
 *                          (110-1 125 m wide, up to 123 734 m²)
 *
 * Nothing exists between 3 cells and 9 cells, so a cap of 4, 5 or 6 gives an
 * IDENTICAL result — 39 holes filled, 50 cells. 6 sits in the middle of that
 * empty band with roughly 3x margin before it could start absorbing real
 * ground.
 *
 * The upper cluster is not noise and must never be filled: the two largest
 * are 11-12 HECTARES, 648 m and 1 125 m across. Those are city-block
 * interiors and gated land somebody ran around, and claiming them is exactly
 * the "invent territory" failure this whole file was written to avoid (see
 * the header, and gap-policy.ts's bridge caps for the same shape of rule
 * applied to time and distance).
 *
 * Why a cell COUNT and not an area or a width: the count is what the fill
 * actually operates on, so a cap expressed in cells cannot drift from what
 * it gates. The metre figures above are reported by measure-holes for
 * judging the number, not for computing it.
 *
 * Re-run `npm run measure-holes` before changing this. The gap in the
 * distribution is the argument; a different city with different block sizes
 * could put the boundary somewhere else.
 */
export const MAX_NOISE_HOLE_CELLS = 6;

/**
 * Cells enclosed by `cells` that are small enough to be sampling noise.
 *
 * The difference from `enclosedCells` is the CAP, and it is why both exist:
 * enclosedCells answers "what did this run surround", which is a claim about
 * one session's loop and is allowed to be large. This answers "where did the
 * fix simply miss", which is only ever defensible at small sizes.
 *
 * The case that motivated it: a runner's history had black hexagons inside
 * a band they had run dozens of times (reported with a screenshot,
 * 2026-09-09). Those cells were in no run's own enclosure, because enclosure
 * is computed PER RUN while the hole was formed by the UNION of many runs
 * over months — so nothing had ever claimed them, on any surface. They are
 * 20-56 m across against consumer GPS accuracy of 5-10 m: the runner did run
 * there, the fix just never landed inside the cell.
 *
 * Each hole is judged WHOLE, never partially filled. Taking the first six
 * cells of a 342-cell hole would claim an arbitrary sliver of a city block
 * and leave a ragged edge — worse than leaving it alone, and impossible to
 * explain to the person looking at it.
 *
 * Same walls rule as enclosedCells: only the runner's OWN cells bound a
 * hole, so a rival's territory can never serve as one side of it.
 */
export function noiseHoles(
  cells: string[],
  res: number,
  maxCells: number = MAX_NOISE_HOLE_CELLS,
): string[] {
  // Each hole is judged WHOLE — see this function's doc. holesOf keeps them
  // separate for exactly this reason.
  return holesOf(cells, res)
    .filter((hole) => hole.length <= maxCells)
    .flat();
}

/**
 * The ground ONE run took: every cell it crossed, plus the interior of any
 * loop it closed.
 *
 * The single place that rule is written. Two surfaces draw a run's ground —
 * the Saved tab, per run, and "Where you've run", unioned across a whole
 * history — and they must not each assemble it themselves. That is not a
 * style preference: `holesOf` exists because the dissolve pipeline had been
 * written out three times and a measurement script had drifted from the
 * shipped code (commit ef92d38), and gap-policy.ts exists because the
 * recorder and the tile builder each applied the caps and disagreed about a
 * real gap.
 *
 * PER RUN is the whole point. Enclosing the union of a runner's history
 * instead would let someone run a city's perimeter over six months and claim
 * everything inside — see this file's header.
 *
 * The claim path does not call this, deliberately: it computes enclosure
 * from the UNMASKED path and zone-filters afterwards (see
 * dropCellsInsideZone), which cannot be done from stored cells that were
 * already trimmed. Callers here work from what was stored, so they get a
 * subset near home and never a leak.
 */
export function groundOfRun(cells: string[], res: number): string[] {
  // Deduplicated BEFORE the dissolve, not only after. cellsToMultiPolygon
  // throws "Duplicate input" rather than degrading, and an exception here
  // unmounts the screen. Every caller today passes a set already
  // (groupVisitsByRun dedupes per run; pathToTiles accumulates into a Set),
  // so this guards the next one — an out-and-back crosses the same cell
  // twice and a raw list of crossings is the obvious thing to hand it.
  const own = [...new Set(cells)];
  return [...new Set([...own, ...enclosedCells(own, res)])];
}
