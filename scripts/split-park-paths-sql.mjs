#!/usr/bin/env node
// Splits the generated park-path data migration into chunks small enough for
// Supabase's SQL editor, which refuses anything near ~1MB ("Query is too large
// to be run via the SQL Editor"). The full migration is ~1.4MB.
//
//   node scripts/split-park-paths-sql.mjs [--bytes 400000]
//
// Chunks are written to supabase/generated/park-paths-chunks/ (gitignored) and
// are idempotent + order-independent: run them in any order, re-run any of
// them, and the result is the same. Cells are emitted as unnest(array[...])
// rather than one tuple per row, which is ~2.3x denser than the migration's
// own form. The source migration stays the record of truth.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'supabase/migrations/20260908211500_park_paths_data.sql';
const OUT = 'supabase/generated/park-paths-chunks';
const argIdx = process.argv.indexOf('--bytes');
const MAX_BYTES = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 400_000;

const sql = readFileSync(SRC, 'utf8');

// The stats upsert, verbatim: small, and already an upsert.
const stats = sql.match(/insert into park_path_stats[\s\S]*?;\n/);
if (!stats) throw new Error('could not find the park_path_stats insert');

// Every ('Municipio', 'h3cell') tuple from the cells insert.
const cells = [...sql.matchAll(/\(\s*'((?:[^']|'')+)',\s*'([0-9a-f]{15})'\s*\)/g)]
  .map(([, municipio, h3]) => [municipio, h3]);
if (!cells.length) throw new Error('no cells parsed — did the generator format change?');

// Group by municipio, preserving first-seen order.
const byMunicipio = new Map();
for (const [municipio, h3] of cells) {
  if (!byMunicipio.has(municipio)) byMunicipio.set(municipio, []);
  byMunicipio.get(municipio).push(h3);
}

const chunks = [];
let body = '';
const flush = () => { if (body) { chunks.push(body); body = ''; } };

for (const [municipio, list] of byMunicipio) {
  const name = municipio.replace(/'/g, "''");
  // Slice each municipio so no single statement can blow the budget on its own.
  const perStatement = Math.max(1, Math.floor(MAX_BYTES / 20));
  for (let i = 0; i < list.length; i += perStatement) {
    const slice = list.slice(i, i + perStatement);
    const stmt =
      `insert into park_path_cells (municipio, h3)\n` +
      `select '${name}', unnest(array[\n  ` +
      slice.map((h3) => `'${h3}'`).join(',') +
      `\n])\non conflict (municipio, h3) do nothing;\n\n`;
    if (body && Buffer.byteLength(body + stmt) > MAX_BYTES) flush();
    body += stmt;
  }
}
flush();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const total = chunks.length;
chunks.forEach((chunkBody, i) => {
  const n = i + 1;
  const header =
    `-- park_path_cells — chunk ${n} of ${total}, generated from\n` +
    `-- ${SRC} by scripts/split-park-paths-sql.mjs.\n` +
    `--\n` +
    `-- Needs supabase/migrations/20260908210000_park_paths.sql (the schema)\n` +
    `-- applied first. Chunks are idempotent and order-independent.\n` +
    `${n === 1 ? '-- This chunk also carries the park_path_stats upsert.\n' : ''}` +
    `-- Verify after the last chunk:\n` +
    `--   select municipio, count(*) from park_path_cells group by 1 order by 1;\n\n` +
    `begin;\n\n`;
  const tail = `commit;\n`;
  const file = join(OUT, `park-paths-${String(n).padStart(2, '0')}-of-${total}.sql`);
  writeFileSync(file, header + (n === 1 ? stats[0] + '\n' : '') + chunkBody + tail);
});

console.log(`${cells.length} cells across ${byMunicipio.size} municipios -> ${total} chunk(s) in ${OUT}/`);
