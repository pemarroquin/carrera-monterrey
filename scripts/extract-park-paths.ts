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
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compactCells, gridPathCells, latLngToCell } from 'h3-js';

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
 * Overpass RATE LIMITS HARD. A plain loop over six municipios returned empty
 * bodies for most of them (measured 2026-09-08) — and an empty body parses
 * as a JSON error, not as "no parks", so a naive script would record zero
 * and look successful. Back off properly and treat a failure as fatal for
 * that municipio rather than as an empty result.
 */
async function overpass<T>(query: string, attempt = 0): Promise<T> {
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: { 'User-Agent': 'runners-races-mx park-path extraction' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if (attempt >= 3) throw e;
    const waitMs = 20_000 * (attempt + 1);
    console.log(`    overpass failed (${e instanceof Error ? e.message : e}) — retrying in ${waitMs / 1000}s`);
    await new Promise((r) => setTimeout(r, waitMs));
    return overpass<T>(query, attempt + 1);
  }
}

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

interface MunicipioResult {
  municipio: string;
  parks: number;
  namedParks: number;
  pathKm: number;
  cells: string[];
}

async function extract(municipio: string): Promise<MunicipioResult> {
  // Scoped through the STATE area: municipio names repeat across Mexico
  // (there is a Guadalupe in several states), and an unscoped name lookup
  // silently returns the wrong one or nothing at all.
  const scope = `area["name"="${STATE}"]["admin_level"="4"]->.st;
area["name"="${municipio}"]["admin_level"="6"](area.st)->.m;`;

  const parkQuery = `[out:json][timeout:300];
${scope}
(way(area.m)["leisure"="park"];relation(area.m)["leisure"="park"];);
out tags;`;
  const parks = await overpass<{ elements: { tags?: Record<string, string> }[] }>(parkQuery);
  const namedParks = parks.elements.filter((e) => e.tags?.name).length;

  await new Promise((r) => setTimeout(r, 5_000));

  // map_to_area turns the park polygons themselves into a search area, so
  // this picks up ways inside RELATIONS (multipolygon parks) too, not just
  // simple closed ways.
  const pathQuery = `[out:json][timeout:300];
${scope}
(way(area.m)["leisure"="park"];relation(area.m)["leisure"="park"];)->.parks;
.parks map_to_area ->.pa;
way(area.pa)["highway"~"${RUNNABLE}"];
out geom;`;
  const ways = await overpass<{ elements: OsmWay[] }>(pathQuery);

  const cells = new Set<string>();
  let metres = 0;
  for (const w of ways.elements) {
    if (!w.geometry || w.geometry.length < 2) continue;
    for (let i = 1; i < w.geometry.length; i++) metres += segmentM(w.geometry[i - 1], w.geometry[i]);
    for (const c of wayCells(w.geometry, DEFAULT_TILE_RES)) cells.add(c);
  }

  return {
    municipio,
    parks: parks.elements.length,
    namedParks,
    pathKm: metres / 1000,
    cells: [...cells].sort(),
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

  const results: MunicipioResult[] = [];
  for (const [i, m] of targets.entries()) {
    console.log(`[${i + 1}/${targets.length}] ${m}`);
    try {
      const r = await extract(m);
      results.push(r);
      const compacted = compactCells(r.cells);
      console.log(
        `    ${r.parks} parks (${r.namedParks} named), ${r.pathKm.toFixed(1)} km of path, ` +
          `${r.cells.length} cells (${compacted.length} compacted)`,
      );
    } catch (e) {
      // Loudly, and skipped — a municipio recorded with zero cells would show
      // every runner 0% progress there and look like a real answer.
      console.log(`    FAILED: ${e instanceof Error ? e.message : e} — SKIPPED, not recorded as empty`);
    }
    // Between municipios, not just between retries.
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 10_000));
  }

  const outDir = path.join(ROOT, 'supabase/generated');
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

  const sqlPath = path.join(outDir, `${stamp}_park_paths.sql`);
  const rows = results.flatMap((r) => r.cells.map((h3) => `  ('${r.municipio.replace(/'/g, "''")}', '${h3}')`));
  writeFileSync(
    sqlPath,
    `-- Park-path denominator cells, generated ${new Date().toISOString()}.\n` +
      `-- ${results.length} municipio(s), ${rows.length} cells.\n` +
      `-- Needs a park_path_cells(municipio text, h3 text) table; see the backlog spec\n` +
      `-- for why the DB path may beat a bundled seed (a bundled seed is ~120 KB per\n` +
      `-- municipio, so all 51 of Nuevo León would be ~6 MB).\n\nbegin;\n` +
      `insert into park_path_cells (municipio, h3) values\n${rows.join(',\n')}\non conflict do nothing;\n\ncommit;\n`,
  );

  const totalCells = results.reduce((n, r) => n + r.cells.length, 0);
  console.log(`\n${results.length}/${targets.length} municipios extracted, ${totalCells} cells total`);
  console.log(`  ${path.relative(ROOT, seedPath)}  (${(JSON.stringify(seed).length / 1024).toFixed(0)} KB)`);
  console.log(`  ${path.relative(ROOT, sqlPath)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
