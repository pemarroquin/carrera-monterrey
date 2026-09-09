// The arena — district.ts. Board 1's scope, and the replacement for the old
// region/global pill pair.
//
// The measurements that drove the design (res-7 areas, the 21.3% municipio
// ambiguity) are asserted here rather than only written in comments, so a
// later "correction" of DISTRICT_RES or a return to municipio boundaries
// fails loudly instead of quietly changing what every score means.
import {
  UNITS,
  cellToCenterChild,
  cellToChildren,
  cellToLatLng,
  cellToParent,
  getHexagonAreaAvg,
  getResolution,
  gridDisk,
  latLngToCell,
} from 'h3-js';
import { describe, expect, it } from 'vitest';

import {
  DISTRICT_RES,
  districtCellPattern,
  districtLabel,
  districtOf,
  districtOfCell,
  isInDistrict,
} from '../src/lib/district';
import { DEFAULT_TILE_RES } from '../src/lib/tiles';

const MTY = { lat: 25.6866, lng: -100.3161 };

/** Spread across base cells, hemispheres and latitudes — H3 index layout
 *  varies by base cell, and pentagon-adjacent maths differs near the poles. */
const WORLDWIDE = [
  MTY,
  { lat: 19.4326, lng: -99.1332 }, // CDMX
  { lat: 21.1619, lng: -86.8515 }, // Cancún
  { lat: 32.5149, lng: -117.0382 }, // Tijuana
  { lat: -33.8688, lng: 151.2093 }, // Sydney
  { lat: 64.1466, lng: -21.9426 }, // Reykjavík
  { lat: 0.3476, lng: 32.5825 }, // Kampala
  { lat: -54.8019, lng: -68.303 }, // Ushuaia
];

describe('DISTRICT_RES', () => {
  it('is res 7 — ~5.2 km2, about 2.8 km across', () => {
    expect(DISTRICT_RES).toBe(7);
    const km2 = getHexagonAreaAvg(DISTRICT_RES, UNITS.km2);
    // Measured, not recalled. A 5 km run crosses this; that is the whole
    // selection criterion (contestability).
    expect(km2).toBeGreaterThan(5);
    expect(km2).toBeLessThan(5.3);
  });

  it('has no intermediate size available — H3 steps by ~7x per resolution', () => {
    // Documents why "make the district a bit smaller" is not a request that
    // can be honoured. Same trap the backlog recorded for tile resolution.
    const here = getHexagonAreaAvg(DISTRICT_RES, UNITS.km2);
    const coarser = getHexagonAreaAvg(DISTRICT_RES - 1, UNITS.km2);
    expect(coarser / here).toBeGreaterThan(6.5);
    expect(coarser / here).toBeLessThan(7.5);
  });

  it('is coarser than the tile resolution, so tiles nest inside districts', () => {
    expect(DISTRICT_RES).toBeLessThan(DEFAULT_TILE_RES);
  });
});

describe('districtOf', () => {
  it('resolves a position to one district, with no network or table', () => {
    const district = districtOf(MTY);
    expect(getResolution(district)).toBe(DISTRICT_RES);
  });

  it('is unambiguous by construction — the property municipios lack', () => {
    // The failure this design exists to avoid: a point cannot be in two
    // districts, so there is no boundary case to resolve and no majority
    // vote in the scoring path.
    expect(districtOf(MTY)).toBe(districtOf({ ...MTY }));
  });

  it('AGREES with truncating the position\'s own tile, worldwide', () => {
    // The bug this pins down: H3's hierarchy is index truncation, not
    // geometry, so latLngToCell(p, 7) and cellToParent(latLngToCell(p, 12), 7)
    // differ near a cell boundary. If districtOf used the direct call, a
    // runner would be shown a district their own tiles truncate out of —
    // their ground missing from the board they are looking at, and the
    // server-side LIKE prefix matching none of it.
    //
    // Monterrey agrees either way, which is exactly why this is asserted
    // across base cells: the bug would have shipped and then surfaced only
    // for runners in other cities.
    for (const place of WORLDWIDE) {
      const own = latLngToCell(place.lat, place.lng, DEFAULT_TILE_RES);
      expect(districtOf(place)).toBe(districtOfCell(own));
    }
  });

  it('puts a nearby position in the same district and a distant one elsewhere', () => {
    // Measured from the district's OWN CENTRE, not from an arbitrary point.
    // Monterrey's nominal centre happens to sit close to a res-7 boundary,
    // so 200 m east of it is genuinely a different district — that is the
    // grid behaving correctly, and the next test pins it down deliberately.
    const [lat, lng] = cellToLatLng(districtOf(MTY));
    // ~200 m: same arena.
    expect(districtOf({ lat, lng: lng + 0.002 })).toBe(districtOf({ lat, lng }));
    // ~20 km east: a different arena.
    expect(districtOf({ lat, lng: lng + 0.2 })).not.toBe(districtOf({ lat, lng }));
  });

  it('switches arena at a boundary, and that is the honest answer', () => {
    // A grid has edges, and a runner standing near one competes in whichever
    // cell they are actually in. Worth an assertion because it is the ONE
    // place this design is visibly imperfect — and it is still strictly
    // better than the alternative it replaced, where 21.3% of res-7 parents
    // straddled two municipios and the SCORE, not just the caption, was
    // ambiguous. Here the arena is always exactly one cell; only which cell
    // you are in changes, and it changes the same way for everyone.
    const near = districtOf(MTY);
    const across = districtOf({ lat: MTY.lat, lng: MTY.lng + 0.002 });
    expect(near).not.toBe(across);
    // Both are still real, single, unambiguous districts.
    expect(getResolution(near)).toBe(DISTRICT_RES);
    expect(getResolution(across)).toBe(DISTRICT_RES);
  });
});

describe('districtOfCell', () => {
  it('maps a tile-resolution cell to its district by truncation', () => {
    const cell = latLngToCell(MTY.lat, MTY.lng, DEFAULT_TILE_RES);
    expect(districtOfCell(cell)).toBe(cellToParent(cell, DISTRICT_RES));
    // And it agrees with resolving the position directly — the two paths
    // must never disagree about where a runner is competing.
    expect(districtOfCell(cell)).toBe(districtOf(MTY));
  });

  it('REFUSES a cell at the wrong resolution rather than guessing', () => {
    // Pre-conversion res-11 tiles still exist. cellToParent would happily
    // return a district for one, which would mix two resolutions into a
    // single district's totals. An unconverted tile must read as "not
    // counted", never as territory.
    const oldCell = latLngToCell(MTY.lat, MTY.lng, 11);
    expect(districtOfCell(oldCell)).toBeNull();
    expect(isInDistrict(oldCell, districtOf(MTY))).toBe(false);
  });
});

describe('districtLabel', () => {
  const district = districtOf(MTY);
  const inside = (n: number) => latLngToCell(MTY.lat + n * 0.0004, MTY.lng, DEFAULT_TILE_RES);

  it('labels a district by majority vote over its park cells', () => {
    const label = districtLabel(district, [
      { h3: inside(0), municipio: 'Monterrey' },
      { h3: inside(1), municipio: 'Monterrey' },
      { h3: inside(2), municipio: 'San Pedro Garza García' },
    ]);
    expect(label).toBe('Monterrey');
  });

  it('ignores park cells outside the district', () => {
    const label = districtLabel(district, [
      { h3: inside(0), municipio: 'Monterrey' },
      // 20 km away, so a different district entirely — must not vote here.
      { h3: latLngToCell(MTY.lat, MTY.lng + 0.2, DEFAULT_TILE_RES), municipio: 'Elsewhere' },
      { h3: latLngToCell(MTY.lat, MTY.lng + 0.2004, DEFAULT_TILE_RES), municipio: 'Elsewhere' },
      { h3: latLngToCell(MTY.lat, MTY.lng + 0.2008, DEFAULT_TILE_RES), municipio: 'Elsewhere' },
    ]);
    expect(label).toBe('Monterrey');
  });

  it('is STABLE on a tie regardless of row order', () => {
    // A 50/50 district must not flip its caption between two fetches. The
    // rows arrive in whatever order PostgREST returns them.
    const rows = [
      { h3: inside(0), municipio: 'Zeta' },
      { h3: inside(1), municipio: 'Alpha' },
    ];
    expect(districtLabel(district, rows)).toBe('Alpha');
    expect(districtLabel(district, [...rows].reverse())).toBe('Alpha');
  });

  it('returns null where there is no park data — most of the planet', () => {
    // Callers must draw the map instead of inventing a name. Only seven
    // Nuevo León municipios are extracted.
    expect(districtLabel(district, [])).toBeNull();
  });
});

describe('districtCellPattern', () => {
  it('matches every tile-resolution cell in the district and nothing outside it', () => {
    const district = districtOf(MTY);
    const pattern = districtCellPattern(district);
    // Every child shares it...
    for (const child of cellToChildren(district, DEFAULT_TILE_RES)) {
      expect(child.startsWith(pattern)).toBe(true);
    }
    // ...and no neighbouring district's cells do. This is what makes the
    // server-side filter exact rather than approximate.
    for (const neighbour of gridDisk(district, 1).filter((c) => c !== district)) {
      expect(cellToCenterChild(neighbour, DEFAULT_TILE_RES).startsWith(pattern)).toBe(false);
    }
  });

  it('is 2 + DISTRICT_RES characters — the two nibbles plus one per digit', () => {
    expect(districtCellPattern(districtOf(MTY))).toHaveLength(2 + DISTRICT_RES);
  });

  it('holds across base cells worldwide, including polar and southern', () => {
    // A prefix that silently matched nothing would read as "this district is
    // empty", not as an error — the same failure mode tiles.ts guards for.
    for (const place of WORLDWIDE) {
      const district = districtOf(place);
      const pattern = districtCellPattern(district);
      expect(pattern).toHaveLength(2 + DISTRICT_RES);
      expect(latLngToCell(place.lat, place.lng, DEFAULT_TILE_RES).startsWith(pattern)).toBe(true);
    }
  });
});
