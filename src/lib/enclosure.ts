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
export function enclosedCells(cells: string[], res: number): string[] {
  // Two cells cannot surround anything; skip the dissolve entirely.
  if (cells.length < 3) return [];

  // GeoJSON winding ([lng, lat]) from both calls, so the rings handed to
  // polygonToCells are already in the order it expects.
  const outlines = cellsToMultiPolygon(cells, true);

  const owned = new Set(cells);
  const enclosed = new Set<string>();

  for (const polygon of outlines) {
    // Ring 0 is the outer boundary; every ring after it is a hole — an
    // empty region this cell set surrounds.
    for (let ring = 1; ring < polygon.length; ring++) {
      for (const cell of polygonToCells([polygon[ring]], res, true)) {
        // polygonToCells fills by cell centre, so a cell of the ring itself
        // can be picked up when the hole's edge runs through it. Claiming
        // it again would be harmless but double-counts in every total.
        if (!owned.has(cell)) enclosed.add(cell);
      }
    }
  }

  return [...enclosed];
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
