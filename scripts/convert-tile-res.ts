#!/usr/bin/env npx vite-node
// Rebuilds every stored territory tile at the CURRENT tile resolution, and
// writes the result as a SQL migration for a human to review and apply.
//
// Why this exists: DEFAULT_TILE_RES changed from 11 to 12 on 2026-09-07
// (owner's call — see tiles.ts). H3 cell ids encode their own resolution, so
// res-11 rows and res-12 rows can never collide, share, or replace each
// other. Left alone, every tile claimed before the change would simply stop
// counting: the app would render and total only res-12 cells and the old
// territory would sit in the table, invisible. This converts it.
//
// It REBUILDS FROM `runs.raw_path`, it does not split old cells into their
// seven children. That distinction is the whole point:
//
//   - Splitting a parent claims all seven children, including ground up to
//     ~29 m from where the runner actually was. A res-11 cell was claimed
//     because the path clipped it — its children cover a lot the path never
//     touched. That would invent territory, which is the one thing this
//     codebase refuses to do (see gap-policy.ts and pathToTiles' bridge
//     caps: an unknown is left as a hole, never guessed).
//   - The path is still stored for every run (`runs.raw_path`, jsonb,
//     `[[lat,lng,ts], ...]`), so the honest answer is recoverable exactly.
//     Despite the column name that path is the privacy-MASKED one: uploadRun
//     writes raw_path from the same `run.points` it passes to pathToTiles,
//     and index.tsx's save() sets that to `masked.points`. So rebuilding
//     from it reproduces the app's original input exactly — it cannot claim
//     ground inside a privacy zone that the first claim excluded.
//
// It imports the app's OWN pathToTiles rather than reimplementing it, so the
// converted tiles are computed by the same code, with the same gap policy
// and bridge caps, that produced the originals. That is why this file is
// TypeScript run through vite-node (which resolves the `@/` alias from
// vitest.config.ts) instead of a plain .mjs like the other scripts.
//
// Read-only against the database. It writes nothing: the anon key it uses
// cannot insert territory_tiles for another session anyway (RLS:
// `auth.uid() = owner_id`) and there is no delete policy at all, which is
// exactly why the conversion has to be SQL applied by hand.
//
//   npm run convert-tile-res            # write the migration
//   npm run convert-tile-res -- --dry   # report only, write nothing
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellToParent } from 'h3-js';

import { DEFAULT_TILE_RES, pathToTiles, type TilePoint } from '@/lib/tiles';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The resolution being migrated AWAY from. Explicit, not inferred: the
 *  table may hold rows from more than one past resolution, and only this
 *  one is being converted. */
const OLD_RES = 11;

function env(name: string): string {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const ANON = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');

async function rest<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** SQL string literal. Every value written here is a uuid, an ISO timestamp
 *  or an H3 id, but quoting is not optional just because the inputs look
 *  tame — region ids are free text and this output is executed as SQL. */
const q = (v: string | null): string => (v === null ? 'null' : `'${v.replace(/'/g, "''")}'`);

interface RunRow {
  id: string;
  user_id: string;
  region: string | null;
  started_at: string;
  ended_at: string;
  raw_path: [number, number, number][] | null;
}

interface TileRow {
  h3: string;
  owner_id: string;
  first_claimed_at: string;
  claim_run_id: string | null;
  region_id: string | null;
}

async function main() {
  const dry = process.argv.includes('--dry');

  const runs = await rest<RunRow[]>(
    'runs?select=id,user_id,region,started_at,ended_at,raw_path&order=started_at.asc',
  );
  const existing = await rest<TileRow[]>(
    'territory_tiles?select=h3,owner_id,first_claimed_at,claim_run_id,region_id',
  );

  const old = existing.filter((t) => t.h3[1] === OLD_RES.toString(16));
  const already = existing.length - old.length;

  // Parent cell -> the row it was claimed under, so a converted child can
  // inherit the real first_claimed_at instead of being back-dated to its
  // run's end time.
  const parents = new Map(old.map((t) => [t.h3, t]));

  // First-to-claim, replayed on the new geometry: runs are processed oldest
  // first and a cell belongs to the first run that covers it, which is the
  // same rule territory_tiles' primary key + `on conflict do nothing`
  // enforces live (see claimTiles).
  const owners = new Map<string, { run: RunRow; firstClaimedAt: string }>();
  const visits: { h3: string; userId: string; runId: string; at: string }[] = [];
  let skippedRuns = 0;

  for (const run of runs) {
    if (!Array.isArray(run.raw_path) || run.raw_path.length === 0) {
      skippedRuns++;
      continue;
    }
    const points: TilePoint[] = run.raw_path.map(([lat, lng, ts]) => ({ lat, lng, ts }));
    const { cells } = pathToTiles(points, DEFAULT_TILE_RES);

    for (const cell of cells) {
      visits.push({ h3: cell, userId: run.user_id, runId: run.id, at: run.ended_at });
      if (owners.has(cell)) continue;
      const parent = parents.get(cellToParent(cell, OLD_RES));
      owners.set(cell, {
        run,
        // Inherit the moment the ground was really first claimed when the
        // old parent tile says so; otherwise this run is the first claim.
        firstClaimedAt: parent?.first_claimed_at ?? run.ended_at,
      });
    }
  }

  console.log(`runs:            ${runs.length} (${skippedRuns} with no raw_path, skipped)`);
  console.log(`tiles at res ${OLD_RES}:  ${old.length}  (to be replaced)`);
  console.log(`tiles already at ${DEFAULT_TILE_RES}: ${already}`);
  console.log(`rebuilt at res ${DEFAULT_TILE_RES}:  ${owners.size} owned, ${visits.length} visit rows`);
  const ratio = old.length > 0 ? (owners.size / old.length).toFixed(2) : 'n/a';
  console.log(`expansion:       ${ratio}x  (7.00x would mean every child of every old cell)`);

  if (dry) return;
  if (owners.size === 0) {
    console.log('\nNothing to convert — no run produced any cell. No migration written.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.join(ROOT, 'supabase/generated');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${stamp}_tiles_res${DEFAULT_TILE_RES}_data.sql`);

  const tileValues = [...owners.entries()]
    .map(([h3, { run, firstClaimedAt }]) =>
      `  (${q(h3)}, ${q(run.user_id)}, ${q(firstClaimedAt)}, ${q(run.id)}, ${q(run.ended_at)}, ${q(run.region)})`,
    )
    .join(',\n');

  const visitValues = visits
    .map((v) => `  (${q(v.h3)}, ${q(v.userId)}, ${q(v.runId)}, ${q(v.at)})`)
    .join(',\n');

  const sql = `-- GENERATED by scripts/convert-tile-res.ts on ${new Date().toISOString()}.
-- Regenerate with: npm run convert-tile-res
--
-- NOT COMMITTED (supabase/generated/ is gitignored) — it is a one-off
-- backfill of live rows, regenerable from the database at any time, and it
-- would otherwise put ${owners.size} lines of one person's location history into git
-- history permanently. The SCHEMA half of this change is committed, as
-- supabase/migrations/20260907130000_tile_res12_guard.sql.
--
-- Converts stored territory from H3 res ${OLD_RES} to res ${DEFAULT_TILE_RES}, rebuilt from each
-- run's own stored path by the app's own pathToTiles — NOT by splitting old
-- cells into children, which would claim ground nobody ran over. See the
-- script header. That the rebuild came out ${ratio}x rather than 7.00x is the
-- measurement of exactly that difference.
--
-- Source data at generation time: ${runs.length} runs, ${old.length} res-${OLD_RES} tiles in the table.
-- Result: ${owners.size} owned tiles, ${visits.length} visit rows.
--
-- ORDER: apply 20260907130000_tile_res12_guard.sql FIRST. It re-bounds the
-- forgery guard for the new tile size; until it is applied, the inserts
-- below are measured against a bound computed for 25 m tiles and can be
-- REJECTED outright.
--
-- Wrapped in a transaction: a partial conversion would leave the table
-- holding a mix of both resolutions with no record of how far it got.

begin;

-- An H3 id's SECOND character is its resolution nibble ('${OLD_RES.toString(16)}' = res ${OLD_RES}), which
-- is how these rows are selected without the h3-pg extension installed. The
-- leading _ is LIKE's single-character wildcard, deliberately unescaped.
-- Asserted against h3-js itself in test/tiles.test.ts.
--
-- tile_visits first: the guard above counts rows in it, so clearing the old
-- resolution before inserting the new one keeps that count from briefly
-- reflecting both at once.
delete from tile_visits where h3 like '_${OLD_RES.toString(16)}%';
delete from territory_tiles where h3 like '_${OLD_RES.toString(16)}%';

insert into tile_visits (h3, user_id, run_id, visited_at) values
${visitValues}
on conflict (h3, run_id) do nothing;

insert into territory_tiles (h3, owner_id, first_claimed_at, claim_run_id, last_visited_at, region_id) values
${tileValues}
on conflict (h3) do nothing;

-- Nothing at the old resolution may survive this migration.
do $$
declare leftover integer;
begin
  select count(*) into leftover from territory_tiles where h3 like '_${OLD_RES.toString(16)}%';
  if leftover > 0 then
    raise exception 'conversion left % res-${OLD_RES} tiles behind', leftover;
  end if;
end $$;

commit;
`;

  writeFileSync(outPath, sql);
  console.log(`\nWrote ${path.relative(ROOT, outPath)} (${(sql.length / 1024).toFixed(0)} KB)`);
  console.log('Apply IN THIS ORDER, by hand in the Supabase SQL editor, BEFORE deploying:');
  console.log('  1. supabase/migrations/20260907130000_tile_res12_guard.sql');
  console.log(`  2. ${path.relative(ROOT, outPath)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
