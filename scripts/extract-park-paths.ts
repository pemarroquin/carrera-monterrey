#!/usr/bin/env npx vite-node
// Builds the denominator for park-path progress: the H3 cells covered by
// runnable paths inside parks, per municipio.
//
// WHY PATHS AND NOT PARKS OR AREA — measured, not assumed (see the backlog
// spec). One 5.7 km run in San Pedro Garza García is 0.262% of the
// municipio's area, 0.63% of its whole street network, and 5.5% of its park
// paths. Only the last is a bar that moves. Park COUNT fails too: 133 of San
// Pedro's 168 parks are under 1 ha, so counting them measures traffic-island
// visits. Path length self-filters — an island contributes ~0 km, a real
// park 1-5 km — which is the same conclusion Wandrer and CityStrides each
// reached independently.
//
// Read-only against OSM. Writes to supabase/generated/ (gitignored) so the
// output can be sized and inspected BEFORE anyone decides where it lives:
// at ~6 900 cells per municipio a bundled seed is ~120 KB, which is fine for
// the metro area and 6 MB for all 51 municipios of Nuevo León. The script
// reports both a JSON seed and a SQL insert so that decision is made on
// evidence.
//
//   npm run extract-park-paths                     # the Monterrey metro
//   npm run extract-park-paths -- "Monterrey"      # named municipios
//   npm run extract-park-paths -- --state          # every municipio in NL
//   npm run extract-park-paths -- --resume         # skip ones already done
//
// USE --resume. Overpass will not serve a full metro run in one go: it
// starts returning 429s and 504s partway through and eventually refuses
// outright, and clipping doubled the requests per municipio (parks, paths,
// boundary). A run that gets 2 of 7 is normal. --resume merges into the most
// recent output and skips what is already there, so three patient runs
// finish the metro where one impatient one cannot.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellToLatLng, compactCells, gridPathCells, latLngToCell } from 'h3-js';

import { DEFAULT_TILE_RES } from '@/lib/tiles';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = 'Nuevo León';

/** The municipios anyone actually runs in today. `--state` overrides. */
const METRO = [
  'Monterrey',
  'San Pedro Garza García',
  'Guadalupe',
  'San Nicolás de los Garza',
  'Santa Catarina',
  'Apodaca',
  'General Escobedo',
];

/**
 * Ways a runner can actually use. Deliberately broader than footpaths:
 * residential streets inside a park are how you get between its sections,
 * and excluding them under-counts the ground a park really offers. Excludes
 * anything a person should not be running along — trunk roads, motorways.
 */
const RUNNABLE =
  '^(footway|path|pedestrian|track|cycleway|living_street|residential|steps|service)$';

/**
 * Public Overpass instances, tried in turn.
 *
 * More than one because the main instance WILL stop answering. Measured
 * 2026-09-08: after a metro extraction it went from 429s and 504s to
 * refusing connections entirely, while both mirrors stayed healthy.
 * Rotating also spreads the load rather than leaning on one volunteer-run
 * host, which is the polite way to use a free service.
 */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Overpass RATE LIMITS HARD. A plain loop over six municipios returned empty
 * bodies for most of them (measured 2026-09-08) — and an empty body parses
 * as a JSON error, not as "no parks", so a naive script would record zero
 * and look successful. Back off properly, try every mirror, and treat a
 * failure as fatal for that municipio rather than as an empty result.
 */
async function overpass<T>(query: string, attempt = 0): Promise<T> {
  let lastError: unknown = new Error('no mirrors tried');
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'runners-races-mx park-path extraction' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastError = e;
      console.log(`    ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (attempt >= 2) throw lastError;
  const waitMs = 30_000 * (attempt + 1);
  console.log(`    every mirror failed — waiting ${waitMs / 1000}s before another pass`);
  await new Promise((r) => setTimeout(r, waitMs));
  return overpass<T>(query, attempt + 1);
}


type Ring = [number, number][]; // [lng, lat]

/**
 * Stitches an OSM boundary relation's member ways into closed rings.
 *
 * Needed because Overpass returns an admin boundary as a bag of unordered
 * way fragments, not a polygon. Members are joined end to end — each way's
 * last point matches some other way's first or last — until the ring closes.
 */
function stitchRings(members: { geometry?: { lat: number; lon: number }[]; role?: string; type?: string }[]): Ring[] {
  const segs = members
    .filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1 && (m.role === 'outer' || !m.role))
    .map((m) => m.geometry!.map((p): [number, number] => [p.lon, p.lat]));

  const rings: Ring[] = [];
  const pool = [...segs];
  const key = (p: [number, number]) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

  while (pool.length > 0) {
    let ring = pool.pop()!;
    let joined = true;
    while (joined && key(ring[0]) !== key(ring[ring.length - 1])) {
      joined = false;
      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i];
        const end = key(ring[ring.length - 1]);
        if (key(seg[0]) === end) {
          ring = ring.concat(seg.slice(1));
        } else if (key(seg[seg.length - 1]) === end) {
          ring = ring.concat(seg.slice().reverse().slice(1));
        } else {
          continue;
        }
        pool.splice(i, 1);
        joined = true;
        break;
      }
    }
    // An unclosed ring means fragments are missing from the relation — keep
    // it anyway rather than dropping ground; ray casting treats it as closed.
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}

/**
 * Ray casting, written out rather than pulled from @turf: the only turf
 * point-in-polygon in node_modules is a TRANSITIVE dependency, not something
 * this project declares, and a build script should not quietly rely on one.
 */
function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inMunicipio = (lng: number, lat: number, rings: Ring[]) => rings.some((r) => inRing(lng, lat, r));

interface OsmWay {
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
function segmentM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Every cell a way's geometry passes through.
 *
 * NOT pathToTiles, deliberately. That function applies the gap policy —
 * refusing to bridge anything over MAX_BRIDGE_DISTANCE_M because a straight
 * line between two GPS fixes is a guess about which streets the runner took.
 * None of that applies here: this is surveyed geometry, and a 300 m straight
 * segment with two vertices IS the path. Bridging it is correct, and
 * refusing would leave holes in the denominator.
 */
function wayCells(geometry: { lat: number; lon: number }[], res: number): string[] {
  const cells = new Set<string>();
  let prev: string | null = null;
  for (const p of geometry) {
    const cell = latLngToCell(p.lat, p.lon, res);
    cells.add(cell);
    if (prev !== null && prev !== cell) {
      try {
        for (const c of gridPathCells(prev, cell)) cells.add(c);
      } catch {
        // h3 refuses a path between very distant cells. A way that long is
        // malformed data, not a park path — keep the endpoints and move on.
      }
    }
    prev = cell;
  }
  return [...cells];
}

const totalOf = (rs: { cells: string[] }[]) => rs.reduce((n, r) => n + r.cells.length, 0);

interface MunicipioResult {
  municipio: string;
  parks: number;
  namedParks: number;
  pathKm: number;
  cells: string[];
  /** Cells dropped for falling outside the municipio's own boundary. */
  clipped: number;
}

async function extract(municipio: string): Promise<MunicipioResult> {
  // Scoped through the STATE area: municipio names repeat across Mexico
  // (there is a Guadalupe in several states), and an unscoped name lookup
  // silently returns the wrong one or nothing at all.
  const scope = `area["name"="${STATE}"]["admin_level"="4"]->.st;
area["name"="${municipio}"]["admin_level"="6"](area.st)->.m;`;

  // Park IDS first, and cheaply. Ways and relations are kept apart because
  // Overpass addresses them separately (`way(id:…)` / `rel(id:…)`).
  const parkQuery = `[out:json][timeout:300];
${scope}
(way(area.m)["leisure"="park"];relation(area.m)["leisure"="park"];);
out ids tags;`;
  const parks = await overpass<{ elements: { type: string; id: number; tags?: Record<string, string> }[] }>(parkQuery);
  const namedParks = parks.elements.filter((e) => e.tags?.name).length;
  const wayIds = parks.elements.filter((e) => e.type === 'way').map((e) => e.id);
  const relIds = parks.elements.filter((e) => e.type === 'relation').map((e) => e.id);

  // CHUNKED, because map_to_area over every park at once times the server
  // out. Measured 2026-09-08: Guadalupe (804 parks) returned HTTP 504 from
  // BOTH mirrors, repeatedly — a gateway timeout on the query itself, not
  // rate limiting, so retrying the same request could never have worked.
  // 100 parks per request keeps each one small enough to answer.
  const CHUNK = 100;
  const raw = new Set<string>();
  let metres = 0;

  const chunks: string[] = [];
  for (let i = 0; i < wayIds.length; i += CHUNK) {
    chunks.push(`way(id:${wayIds.slice(i, i + CHUNK).join(',')})`);
  }
  for (let i = 0; i < relIds.length; i += CHUNK) {
    chunks.push(`rel(id:${relIds.slice(i, i + CHUNK).join(',')})`);
  }

  for (const [ci, selector] of chunks.entries()) {
    await new Promise((r) => setTimeout(r, 4_000));
    process.stdout.write(`    paths ${ci + 1}/${chunks.length}\r`);
    // map_to_area over the park polygons picks up ways inside RELATION
    // (multipolygon) parks too, which a plain way(area) query misses.
    const ways = await overpass<{ elements: OsmWay[] }>(`[out:json][timeout:300];
(${selector};)->.parks;
.parks map_to_area ->.pa;
way(area.pa)["highway"~"${RUNNABLE}"];
out geom;`);
    for (const w of ways.elements) {
      if (!w.geometry || w.geometry.length < 2) continue;
      for (let i = 1; i < w.geometry.length; i++) metres += segmentM(w.geometry[i - 1], w.geometry[i]);
      for (const c of wayCells(w.geometry, DEFAULT_TILE_RES)) raw.add(c);
    }
  }
  process.stdout.write('                    \r');

  await new Promise((r) => setTimeout(r, 5_000));

  // CLIP TO THE BOUNDARY. Overpass's `way(area.m)` returns ways that
  // INTERSECT an area, not ones strictly inside it, so a park straddling a
  // municipio line is returned for every municipio it touches. Measured
  // before this clip: 8 866 of 47 345 cells (18.7%) were claimed by more
  // than one municipio — Monterrey and San Pedro shared 3 711, which is the
  // Río Santa Catarina linear park running along the boundary between them.
  //
  // Left unfixed that is not a rounding error, it is a broken metric: every
  // denominator is inflated, and running one linear park would credit a
  // runner in three municipios at once, so "% of San Pedro's park paths"
  // would not be a real quantity at all.
  const boundary = await overpass<{ elements: { members?: OsmWay[] }[] }>(`[out:json][timeout:300];
${scope}
relation(area.st)["admin_level"="6"]["name"="${municipio}"];
out geom;`);
  const rings = stitchRings(boundary.elements[0]?.members ?? []);

  const cells = rings.length > 0
    ? [...raw].filter((h3) => {
        const [lat, lng] = cellToLatLng(h3);
        return inMunicipio(lng, lat, rings);
      })
    : [...raw];
  if (rings.length === 0) {
    console.log('    NO BOUNDARY GEOMETRY — cells left unclipped, may overlap neighbours');
  }

  return {
    municipio,
    parks: parks.elements.length,
    namedParks,
    pathKm: metres / 1000,
    cells: cells.sort(),
    clipped: raw.size - cells.length,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const all = process.argv.includes('--state');

  let targets = args.length > 0 ? args : METRO;
  if (all) {
    console.log(`listing every municipio in ${STATE}…`);
    const res = await overpass<{ elements: { tags?: Record<string, string> }[] }>(
      `[out:json][timeout:300];
area["name"="${STATE}"]["admin_level"="4"]->.st;
relation(area.st)["admin_level"="6"]["boundary"="administrative"];
out tags;`,
    );
    targets = res.elements.map((e) => e.tags?.name).filter((n): n is string => !!n);
    console.log(`  ${targets.length} municipios\n`);
  }

  // --resume: carry forward whatever the last run managed to get.
  const outDirEarly = path.join(ROOT, 'supabase/generated');
  const results: MunicipioResult[] = [];
  if (process.argv.includes('--resume')) {
    mkdirSync(outDirEarly, { recursive: true });
    const previous = readdirSync(outDirEarly).filter((f) => f.endsWith('_park_paths.json')).sort().pop();
    if (previous) {
      const prev = JSON.parse(readFileSync(path.join(outDirEarly, previous), 'utf8')) as {
        municipios: Record<string, { parks: number; namedParks: number; pathKm: number; cells: string[] }>;
      };
      for (const [name, m] of Object.entries(prev.municipios)) {
        results.push({ municipio: name, ...m, clipped: 0 });
      }
      console.log(`resuming from ${previous}: ${results.length} municipio(s) already done\n`);
    }
  }
  const done = new Set(results.map((r) => r.municipio));

  for (const [i, m] of targets.entries()) {
    if (done.has(m)) {
      console.log(`[${i + 1}/${targets.length}] ${m} — already extracted, skipping`);
      continue;
    }
    console.log(`[${i + 1}/${targets.length}] ${m}`);
    try {
      const r = await extract(m);
      results.push(r);
      const compacted = compactCells(r.cells);
      console.log(
        `    ${r.parks} parks (${r.namedParks} named), ${r.pathKm.toFixed(1)} km of path, ` +
          `${r.cells.length} cells (${compacted.length} compacted, ${r.clipped} clipped to boundary)`,
      );
    } catch (e) {
      // Loudly, and skipped — a municipio recorded with zero cells would show
      // every runner 0% progress there and look like a real answer.
      console.log(`    FAILED: ${e instanceof Error ? e.message : e} — SKIPPED, not recorded as empty`);
    }
    // Between municipios, not just between retries.
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 10_000));
  }

  const outDir = outDirEarly;
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  const seed = {
    generatedAt: new Date().toISOString(),
    resolution: DEFAULT_TILE_RES,
    state: STATE,
    municipios: Object.fromEntries(
      results.map((r) => [
        r.municipio,
        { parks: r.parks, namedParks: r.namedParks, pathKm: Number(r.pathKm.toFixed(2)), cells: r.cells },
      ]),
    ),
  };
  const seedPath = path.join(outDir, `${stamp}_park_paths.json`);
  writeFileSync(seedPath, JSON.stringify(seed));

  // A real migration, not a gitignored blob. Unlike the tile conversion this
  // is PUBLIC OSM reference data, not one person's location history, so it
  // belongs in the repo where `supabase db push` can apply it — no 1.4 MB
  // paste into a SQL editor.
  const sqlPath = path.join(ROOT, 'supabase/migrations', `${stamp}_park_paths_data.sql`);
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

  const statRows = results
    .map((r) => `  (${q(r.municipio)}, ${r.parks}, ${r.namedParks}, ${r.pathKm.toFixed(2)}, ${r.cells.length})`)
    .join(',\n');
  const cellRows = results
    .flatMap((r) => r.cells.map((h3) => `  (${q(r.municipio)}, '${h3}')`))
    .join(',\n');

  writeFileSync(
    sqlPath,
    `-- GENERATED by scripts/extract-park-paths.ts on ${new Date().toISOString()}.
-- Regenerate with: npm run extract-park-paths -- --resume
--
-- The park-path denominator: ${results.length} municipio(s), ${totalOf(results)} cells,
-- ${results.reduce((k, r) => k + r.pathKm, 0).toFixed(0)} km of runnable path inside parks.
--
-- Needs 20260908210000_park_paths.sql (the schema) applied first.
--
-- Cells are attributed to EXACTLY ONE municipio. Overpass returns ways that
-- INTERSECT an area rather than ones inside it, so before clipping 18.7% of
-- cells belonged to two or three municipios at once — the extraction script
-- clips each cell to the boundary containing its centre.
--
-- Idempotent: re-running replaces the stats and adds no duplicate cells, so
-- a refreshed extraction can be applied over an older one.

begin;

insert into park_path_stats (municipio, parks, named_parks, path_km, cells) values
${statRows}
on conflict (municipio) do update set
  parks = excluded.parks,
  named_parks = excluded.named_parks,
  path_km = excluded.path_km,
  cells = excluded.cells,
  extracted_at = now();

insert into park_path_cells (municipio, h3) values
${cellRows}
on conflict (municipio, h3) do nothing;

commit;
`,
  );

  const totalCells = totalOf(results);
  console.log(`\n${results.length}/${targets.length} municipios in the output, ${totalCells} cells total`);
  if (results.length < targets.length) {
    console.log('  INCOMPLETE — rerun with --resume to pick up the rest once Overpass cools down.');
  }
  console.log(`  ${path.relative(ROOT, seedPath)}  (${(JSON.stringify(seed).length / 1024).toFixed(0)} KB)`);
  console.log(`  ${path.relative(ROOT, sqlPath)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
