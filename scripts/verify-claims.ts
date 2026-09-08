#!/usr/bin/env npx vite-node
// Re-checks what every run CLAIMED against what its stored path can justify.
//
// Conquest removed the guarantee that ownership cannot be stolen. The server
// still bounds SCALE (the isoperimetric ceiling in claim_run_tiles) but
// nothing ties the claimed cells to the claimed path — the check that would
// do that needs lat/lng -> cell inside Postgres, and the h3 extension is not
// available on this instance (see supabase/blocked/). So the tie is made
// here instead, after the fact.
//
// DETECTION, NOT PREVENTION, and deliberately so. At one user that is the
// right proportion, and it buys something prevention would not: this runs
// the app's OWN pathToTiles / enclosedCells / gap-policy, so there is no
// second implementation to drift. Re-implementing enclosure in SQL was the
// alternative, and this repo already has the scar from that pattern —
// gap-policy.ts exists only because the recorder and the tile builder each
// applied the caps themselves and disagreed about one real gap.
//
// Read-only. Uses the anon key and the read-all policies; it cannot modify
// or delete anything. Same posture as audit-territories.mjs.
//
//   npm run verify-claims             # last 14 days
//   npm run verify-claims -- --all    # every run
//   npm run verify-claims -- --json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellToLatLng } from 'h3-js';

import { enclosedCells } from '@/lib/enclosure';
import { DEFAULT_TILE_RES, pathToTiles, type TilePoint } from '@/lib/tiles';
import { haversineM } from '@/lib/territory';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How far outside a run's own recorded bounding box a claimed cell may sit.
 *
 * Enclosure is computed on the device from the UNMASKED path and only the
 * MASKED one is stored (privacy-zone.ts trims 200-350 m off each end), so a
 * perfectly honest run can legitimately claim ground just beyond the stored
 * path's box — near the home the mask exists to hide. This has to cover
 * that, which is why it is the jittered cut's own ceiling plus a little,
 * not a tight bound.
 *
 * The consequence to be honest about: enclosure can never be verified
 * EXACTLY from stored data. That is the privacy design working as intended,
 * not a gap to close. Visits can be, and are, below.
 */
const OFF_PATH_MARGIN_M = 500;

/** Runs to look at by default. Old runs cannot be re-claimed anyway (the
 *  claim window), so an unbounded sweep is for auditing, not monitoring. */
const DEFAULT_DAYS = 14;

function env(name: string): string {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const ANON = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');

async function rest<T>(query: string): Promise<T> {
  const res = await fetch(`${URL_BASE}/rest/v1/${query}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Every row, following PostgREST's 1000-row page cap — a truncated audit
 *  that reports "clean" is worse than no audit. */
async function restAll<T>(table: string, select: string, filter: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest<T[]>(`${table}?select=${select}&${filter}&order=${order}&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

interface Finding {
  runId: string;
  kind: 'visits-extra' | 'visits-missing' | 'enclosed-off-path' | 'no-path';
  detail: string;
  /**
   * Only 'suspect' findings mean a run claimed something its path cannot
   * justify. 'benign' ones are differences with an innocent explanation and
   * must not gate anything — a monitor that cries wolf gets muted, and then
   * it protects nothing.
   */
  severity: 'suspect' | 'benign';
}

async function main() {
  const all = process.argv.includes('--all');
  const asJson = process.argv.includes('--json');
  const since = new Date(Date.now() - DEFAULT_DAYS * 86_400_000).toISOString();

  const runs = await restAll<{
    id: string;
    user_id: string;
    started_at: string;
    distance_m: number;
    raw_path: [number, number, number][] | null;
  }>('runs', 'id,user_id,started_at,distance_m,raw_path', all ? 'id=not.is.null' : `started_at=gte.${since}`, 'started_at.asc');

  const findings: Finding[] = [];
  let checked = 0;

  for (const run of runs) {
    if (!Array.isArray(run.raw_path) || run.raw_path.length === 0) {
      findings.push({
        runId: run.id,
        kind: 'no-path',
        severity: 'suspect',
        detail: 'run stored no path; its claims cannot be justified',
      });
      continue;
    }
    checked++;
    const points: TilePoint[] = run.raw_path.map(([lat, lng, ts]) => ({ lat, lng, ts }));

    // 1. VISITS, exactly. uploadRun derives these from the same masked path
    //    it stores, so this must match cell for cell. tile_visits is
    //    append-only with no update or delete policy, so conquest never
    //    rewrites it — unlike territory_tiles, where a later run takes
    //    ownership and claim_run_id moves. That immutability is what makes
    //    this the reliable check.
    const expected = new Set(pathToTiles(points).cells);
    const visitRows = await restAll<{ h3: string }>('tile_visits', 'h3', `run_id=eq.${run.id}`, 'h3.asc');
    const actual = new Set(visitRows.map((v) => v.h3));

    const extra = [...actual].filter((h3) => !expected.has(h3));
    const missing = [...expected].filter((h3) => !actual.has(h3));
    if (extra.length > 0) {
      // THE signal. Cells logged as visited that the stored path cannot
      // produce is the shape a forged claim takes, and there is no innocent
      // explanation: uploadRun derives these from the very path it stores.
      findings.push({
        runId: run.id,
        kind: 'visits-extra',
        severity: 'suspect',
        detail: `${extra.length} visited cells the stored path cannot produce (e.g. ${extra.slice(0, 3).join(', ')})`,
      });
    }
    if (missing.length > 0) {
      // BENIGN by default, and the reason matters. This recomputes with
      // TODAY's gap policy, so any run uploaded under an older one shows a
      // difference that is a policy change, not a claim. Measured exactly
      // that on first run (2026-09-08): two runs short by 14 and 10 cells,
      // which are precisely the cells the new 10% gap-closure budget bridges
      // and the old flat cap did not — 389 -> 403 and 154 -> 164, matching
      // the independent measurement of that change cell for cell.
      //
      // A partial upload, or a claim that failed after the run row landed,
      // produces the same shape. Reported anyway, because a silent
      // difference is how a real bug hides — just never as a gate.
      findings.push({
        runId: run.id,
        kind: 'visits-missing',
        severity: 'benign',
        detail: `${missing.length} cells the path covers were never logged as visits (older gap policy, or a partial upload)`,
      });
    }

    // 2. ENCLOSURE, bounded. Only cells this run STILL holds — conquest may
    //    have moved the rest, and a tile taken by someone else is no longer
    //    this run's claim to justify.
    const held = await restAll<{ h3: string }>(
      'territory_tiles',
      'h3',
      `claim_run_id=eq.${run.id}`,
      'h3.asc',
    );
    const enclosedClaimed = held.map((t) => t.h3).filter((h3) => !actual.has(h3));

    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of points) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    }
    const offPath = enclosedClaimed.filter((h3) => {
      const [lat, lng] = cellToLatLng(h3);
      const clampedLat = Math.min(Math.max(lat, minLat), maxLat);
      const clampedLng = Math.min(Math.max(lng, minLng), maxLng);
      return haversineM({ lat, lng }, { lat: clampedLat, lng: clampedLng }) > OFF_PATH_MARGIN_M;
    });
    if (offPath.length > 0) {
      findings.push({
        runId: run.id,
        kind: 'enclosed-off-path',
        severity: 'suspect',
        detail: `${offPath.length} owned cells sit more than ${OFF_PATH_MARGIN_M}m outside the recorded path`,
      });
    }

    // A sanity read, not a finding: how much of what this run owns it
    // surrounded rather than covered.
    if (!asJson && enclosedClaimed.length > 0) {
      const sane = enclosedClaimed.length - offPath.length;
      console.log(
        `  ${run.started_at.slice(0, 10)} ${run.id.slice(0, 8)}  ${String(run.distance_m).padStart(5)}m  ` +
          `visited ${String(actual.size).padStart(4)}  surrounded ${String(sane).padStart(5)}`,
      );
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ runs: runs.length, checked, findings }, null, 2));
    return;
  }

  console.log(`\nchecked ${checked} run(s) of ${runs.length}${all ? '' : ` in the last ${DEFAULT_DAYS} days`}`);
  if (findings.length === 0) {
    console.log("no findings — every run's claims are justified by its own stored path.");
    return;
  }
  const suspect = findings.filter((f) => f.severity === 'suspect');
  const benign = findings.filter((f) => f.severity === 'benign');

  if (suspect.length > 0) {
    console.log(`\n${suspect.length} SUSPECT finding(s) — claims the stored path cannot justify:`);
    for (const f of suspect) console.log(`  [${f.kind}] ${f.runId.slice(0, 8)} — ${f.detail}`);
  }
  if (benign.length > 0) {
    console.log(`\n${benign.length} benign difference(s) — reported, not a gate:`);
    for (const f of benign) console.log(`  [${f.kind}] ${f.runId.slice(0, 8)} — ${f.detail}`);
  }
  if (suspect.length === 0) console.log('\nNothing suspect: no run claimed ground its own path cannot justify.');

  // Non-zero ONLY for suspect findings, so this can gate a scheduled job
  // without a benign policy-change difference failing it forever.
  if (suspect.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
