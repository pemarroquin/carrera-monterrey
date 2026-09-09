#!/usr/bin/env node
// Checks that every table this project exposes actually enforces RLS, using
// nothing but the public anon key — the same thing an attacker holds.
//
// Written because a Supabase advisory email was the detection mechanism for
// `spatial_ref_sys` being writable by anyone with the app's shipped anon key
// (2026-09-09). An email arriving days later is not a control. This turns
// that finding into a command.
//
// HOW IT DECIDES, and why the answer is not "can I read it".
// Reading proves nothing here: this app's tables deliberately carry read-all
// policies, so a readable table and an unprotected one look identical. What
// separates them is the ERROR CODE on a write:
//
//     42501  new row violates row-level security policy   -> RLS enforced
//     23502  null value in column ... violates not-null   -> nothing stopped
//            it but a column constraint. RLS is not enforcing.
//
// HOW IT STAYS SAFE. It sends `{}`, an insert with no values, and only to
// tables it has PROVEN cannot accept one: it parses each `create table` in
// supabase/migrations and requires a `not null` column with no `default`.
// Such a row can never be created, so the probe cannot write. A table
// without such a column is SKIPPED and reported, never probed — a checker
// that inserts rows into production to check for a vulnerability is a worse
// bug than the one it looks for.
//
//   npm run verify-rls
//
// Read-only in effect, anon key, same posture as verify-claims and
// measure-holes.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not new URL(...).pathname: this repo lives under a
// directory with a space in it, and the raw pathname keeps it percent-encoded
// ("Claude%20Code"), which then fails to open.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function env(name) {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

/**
 * Every table declared in the migrations, with whether an empty insert is
 * guaranteed to be rejected by a column constraint.
 *
 * Deliberately parsed from the migrations rather than hand-listed: a table
 * added later is one this check must cover automatically, since the whole
 * failure mode is "nobody thought about this table".
 */
export function tablesFromMigrations(dir) {
  const out = new Map();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const re = /create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const [, name, body] = m;
      // A column line is mandatory when it is `not null` and carries no
      // `default`. A primary key without a default counts too — that is what
      // makes spatial_ref_sys's own srid column reject an empty insert.
      const mandatory = body
        .split('\n')
        .map((l) => l.replace(/--.*$/, '').trim())
        .filter((l) => l && !/^(primary key|unique|check|constraint|foreign key)\b/i.test(l))
        .some((l) => (/\bnot null\b/i.test(l) || /\bprimary key\b/i.test(l)) && !/\bdefault\b/i.test(l));
      out.set(name, mandatory);
    }
  }
  return out;
}

// PostGIS puts these in `public` too. They are not in any migration here
// because no migration created them — which is exactly how one of them went
// unnoticed until an email arrived.
const EXTENSION_TABLES = new Map([['spatial_ref_sys', true]]);

async function main() {
  const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
  const ANON = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  const headers = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

  const tables = new Map([
    ...tablesFromMigrations(path.join(ROOT, 'supabase/migrations')),
    ...EXTENSION_TABLES,
  ]);

  const unprotected = [];
  const skipped = [];
  console.log(`  ${'table'.padEnd(22)} ${'pg'.padStart(6)}  verdict`);

  for (const [table, probeIsSafe] of [...tables].sort()) {
    if (!probeIsSafe) {
      skipped.push(table);
      console.log(`  ${table.padEnd(22)} ${'-'.padStart(6)}  SKIPPED: an empty insert might succeed`);
      continue;
    }
    const res = await fetch(`${URL_BASE}/rest/v1/${table}`, { method: 'POST', headers, body: '{}' });
    if (res.status === 404) continue; // not deployed to this project
    let code = '?';
    try {
      code = (await res.json()).code ?? '?';
    } catch {
      // no body
    }
    if (res.ok) {
      unprotected.push(table);
      console.log(`  ${table.padEnd(22)} ${String(res.status).padStart(6)}  *** INSERT ACCEPTED — a row may have been written ***`);
    } else if (code === '42501') {
      console.log(`  ${table.padEnd(22)} ${code.padStart(6)}  RLS enforced`);
    } else {
      unprotected.push(table);
      console.log(`  ${table.padEnd(22)} ${code.padStart(6)}  *** NOT ENFORCED — only a column constraint refused it ***`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n${skipped.length} table(s) not probed: ${skipped.join(', ')}`);
    console.log('Give each a not-null column with no default, or check it by hand.');
  }
  if (unprotected.length > 0) {
    console.error(`\nFAIL: ${unprotected.length} table(s) do not enforce RLS: ${unprotected.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll probed tables enforce RLS.');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
