#!/usr/bin/env npx vite-node
// Measures the HOLES in real covered ground, so the fill cap is picked from
// data rather than from reasoning about GPS accuracy.
//
// The question it answers: a runner's history has black gaps inside bands
// they have run dozens of times (reported with a screenshot, 2026-09-09).
// Those are cells no fix ever landed in, and no single run ever enclosed —
// enclosure is computed PER RUN (index.tsx), while these holes are formed by
// the UNION of many runs over months, so nothing has ever claimed them.
//
// Filling them is defensible only if they are small enough to be sampling
// noise. Filling a large one would claim a park interior or a plaza somebody
// ran around, which is the "invent territory" failure this codebase refuses
// everywhere else (see gap-policy.ts's bridge caps). So the cap matters, and
// guessing it is exactly what this script exists to avoid.
//
// It also answered a SECOND question, which is why it reports both tables:
// whether territory has the same holes. It does not. Measured 2026-09-09,
// the heaviest runner had 38 holes across 919 visited cells and ZERO across
// 1 057 owned ones — per-run enclosure already covers them, because one
// out-and-back down an avenue encloses the strip between its two passes.
// That is what scoped the fill to the history map's render and kept it out
// of the claim path. Check this again before widening it.
//
// Read-only. Anon key and the read-all policies, same posture as
// verify-claims.ts and audit-territories.mjs — it cannot modify anything.
//
//   npm run measure-holes                  # every runner's own coverage
//   npm run measure-holes -- --json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellArea, cellToLatLng, cellsToMultiPolygon, gridDisk, polygonToCells, UNITS } from 'h3-js';

import { MAX_NOISE_HOLE_CELLS, noiseHoles } from '@/lib/enclosure';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function env(name: string): string {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const ANON = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');

/** Every row, following PostgREST's 1000-row page cap. A truncated
 *  measurement would under-report hole sizes, which is the direction that
 *  would produce too permissive a cap. */
async function restAll<T>(query: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${URL_BASE}/rest/v1/${query}&offset=${offset}&limit=1000`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

/**
 * Every hole in a cell set, as its own list of cells.
 *
 * Uses the same dissolve → ring-index-1+ → polygonToCells pipeline as
 * enclosure.ts, deliberately: the numbers reported here have to describe
 * what the real fill would actually see, not an approximation of it. The
 * difference is only that enclosure.ts unions every hole into one set, while
 * this keeps them separate — the SIZE DISTRIBUTION is the whole point.
 */
function holesOf(cells: string[], res: number): string[][] {
  if (cells.length < 3) return [];
  const owned = new Set(cells);
  const holes: string[][] = [];
  for (const polygon of cellsToMultiPolygon(cells, true)) {
    for (let ring = 1; ring < polygon.length; ring++) {
      const filled = polygonToCells([polygon[ring]], res, true).filter((c) => !owned.has(c));
      if (filled.length > 0) holes.push(filled);
    }
  }
  return holes;
}

/**
 * How wide a hole is, in metres — the number that can be compared against
 * GPS accuracy.
 *
 * Measured as the greatest distance between any two cell centres in the
 * hole, plus one cell's own width, rather than as an area: a 6-cell hole
 * shaped like a line is much wider than a 6-cell blob, and it is the WIDTH
 * that decides whether a fix could plausibly have missed it. Reporting only
 * area would hide that.
 */
function spanM(hole: string[]): number {
  const pts = hole.map((c) => cellToLatLng(c));
  let max = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      max = Math.max(max, haversine(pts[i], pts[j]));
    }
  }
  // One cell's own width, so a single-cell hole reports its real size rather
  // than 0.
  return max + cellWidthM(hole[0]);
}

function cellWidthM(cell: string): number {
  const ring = gridDisk(cell, 1).filter((c) => c !== cell);
  if (ring.length === 0) return 0;
  return haversine(cellToLatLng(cell), cellToLatLng(ring[0]));
}

const EARTH_RADIUS_M = 6371008.8;
function haversine([lat1, lng1]: number[], [lat2, lng2]: number[]): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

async function main() {
  const asJson = process.argv.includes('--json');

  // Grouped per user: a hole is only a hole inside ONE runner's own covered
  // ground. Pooling everyone's cells would invent holes between two
  // strangers' territories that neither of them enclosed.
  const rows = await restAll<{ h3: string; user_id: string }>(
    'tile_visits?select=h3,user_id&order=h3.asc,run_id.asc',
  );

  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    // Resolution filter, same reason as every other read that counts tiles:
    // stored res-11 cells from before the conversion cannot mix with res-12
    // ones, and a set holding both would dissolve into nonsense rings.
    if (row.h3[1] !== 'c') continue;
    let set = byUser.get(row.user_id);
    if (!set) {
      set = new Set();
      byUser.set(row.user_id, set);
    }
    set.add(row.h3);
  }

  const report = [...byUser.entries()].map(([userId, set]) => {
    const cells = [...set];
    const holes = holesOf(cells, DEFAULT_TILE_RES);
    const sizes = holes.map((h) => h.length).sort((a, b) => a - b);
    return {
      user: `${userId.slice(0, 8)}…`,
      coveredCells: cells.length,
      holes: holes.length,
      holeCells: sizes.reduce((a, b) => a + b, 0),
      sizes,
      wouldFill: noiseHoles(cells, DEFAULT_TILE_RES).length,
      details: holes
        .map((h) => ({
          cells: h.length,
          spanM: Math.round(spanM(h)),
          areaM2: Math.round(h.reduce((sum, c) => sum + cellArea(c, UNITS.m2), 0)),
        }))
        .sort((a, b) => a.cells - b.cells),
    };
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const r of report) {
    console.log(`\nuser ${r.user}  covered ${r.coveredCells} cells`);
    console.log(`  ${r.holes} holes, ${r.holeCells} cells total`);
    if (r.holes === 0) continue;

    // The distribution is the answer. A cap has to sit above every hole that
    // is noise and below the smallest one that is real ground.
    const buckets = new Map<string, number>();
    for (const d of r.details) {
      const key =
        d.cells === 1 ? '1 cell' : d.cells <= 2 ? '2' : d.cells <= 6 ? '3-6' : d.cells <= 19 ? '7-19' : '20+';
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    for (const [key, n] of buckets) console.log(`    ${key.padEnd(8)} ${n}`);

    console.log('  every hole, smallest first:');
    for (const d of r.details) {
      const verdict = d.cells <= MAX_NOISE_HOLE_CELLS ? 'FILL' : 'keep';
      console.log(
        `    ${verdict}  ${String(d.cells).padStart(4)} cells  ${String(d.spanM).padStart(5)} m wide  ${d.areaM2} m2`,
      );
    }

    // Runs the SHIPPED function, not this script's own copy of the pipeline.
    // The measurement above is what picked the cap; this is what the app will
    // actually do with it, and the two must agree — otherwise the number that
    // justified the constant is describing something the code does not do.
    console.log(`  noiseHoles() would fill ${r.wouldFill} cells at cap ${MAX_NOISE_HOLE_CELLS}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
