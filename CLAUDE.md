# CLAUDE.md — Runners' Races MX

Guidance for Claude Code working in this repo, including the Mon+Fri
**race-watch** cloud routine. Read this before touching
`assets/data/races.json`.

## The sweep contract (read this first)

A verification sweep's job is to **correct the data**, not to describe what it
found. The three fields `status` / `statusNote` / `lastVerified` are the *audit
trail for a change* — they are never the change itself.

**Write the corrected field first. Then explain it in `statusNote`.**

This is not a style preference. On 2026-08-10 an audit found six records where
a sweep had proved something and written it only in prose:

- **Carrera SABA Monterrey** — the sweep confirmed the start had moved to Av.
  Pedro de Alba, Ciudad Universitaria UANL, and wrote that in `statusNote`.
  `venue` still said `Parque Fundidora`, `city` still said Monterrey (the new
  venue is in San Nicolás), and `start` still pinned the map ~4 km away. The
  app showed runners the wrong start line.
- **Medio Maratón Ensenada** — the sweep proved, with official `ensenada.gob.mx`
  start *and* results coverage, that the race had already been run on 17 May.
  `date` stayed `2026-08-17`, so the app kept advertising it as upcoming in
  seven days, with a live signup link and no checkout gate.

So, when a sweep finds something:

| Finding | Field to write | Then |
|---|---|---|
| Venue moved | `venue`, and `city`/`start` if the municipality or coordinates changed | note it |
| Date wrong / race already run | `date` | note it |
| Race canceled | `status: 'canceled'` **and** `signupUrl: null` | note it |
| Postponed, new date unknown | `date: null`, `status: 'changed'` **and** `signupUrl: null` | note it |
| Start time found or corrected | `time` | note it |
| Current-edition registration found | `signupUrl` | note it |
| Nothing changed | `status: 'ok'` | short note |

### `statusNote` is user-facing

It renders verbatim in the orange banner on the race detail screen, for
`changed` and `canceled` only. Keep it to a few plain sentences a runner can
act on. Everything about *how* you verified — which site was blocked, which
calendars disagreed, confidence changes — goes in `sourceNotes`, which users
never see. Same split as `notes` vs `sourceNotes`.

**Spanish is the app's default locale.** Every `changed`/`canceled` record must
carry a `statusNoteEs`. `notes` has the same rule via `notesEs`.

### Conflicts are recorded, not resolved silently

Two sources disagree → keep the better-evidenced value, write the conflict in
`sourceNotes`. Never guess. Unknown stays `null` — a `null` is a valid finding,
a plausible guess is data poisoning.

## Validate before committing

```bash
npm run verify-sweep                          # static invariants
node scripts/verify-sweep.mjs --base main     # + "narrated but not applied"
npx tsc --noEmit
npx expo export -p web
```

`scripts/verify-sweep.mjs` enforces the contract above. Its sharpest check is
diff-aware: if a record declares `status: 'changed'` and bumps `lastVerified`
but no user-visible field differs from the base ref, that is the exact defect
described here and it fails the build. Run against the pre-fix data, it catches
both incidents above by name.

CI runs it on every pull request and every push to main
(`.github/workflows/data-check.yml`).

## Repo gotchas

- **`deploy.yml` is push-to-main only.** Before `data-check.yml` existed, pull
  requests ran *no checks at all* and a green PR proved nothing. Data and type
  checks now run on PRs; the deploy still only runs on main.
- **The race-watch routine commits to `main` every Mon + Fri**, touching only
  `races.json`. Any branch editing that file will conflict on rebase — resolve
  per hunk (keep upstream's `status`/`statusNote`/`lastVerified`, keep the
  branch's other fields). Never blanket `--ours` / `--theirs`.
- **The bundled seed is not what users see.** The app fetches
  `assets/data/races.json` from `main` on every open and replaces its in-memory
  copy wholesale (`REMOTE_RACES_URL` in `src/lib/races.ts`). Data edited on a
  branch reaches nobody until that branch merges to `main`.
- A record that fails `isValidRace()` in `src/lib/races.ts` is silently
  **dropped** at runtime, so a schema slip reads as "races disappeared", not as
  an error. `verify-sweep.mjs` mirrors that validator.
- `_meta.count` is not read by the app, but it drifted to 114 against 195 real
  records because sweeps never touched it. The gate now checks it.

## Territory Mode — the two boards

Two leaderboards, and they measure different things on purpose. Do not merge
them, and do not add a scope picker to either.

**The arena is an H3 res-7 district** (`src/lib/district.ts`), ~5.16 km² and
~2.8 km across — the ground you are standing in, resolved locally with no
table, no migration and no round trip. It is NOT a municipio: nothing here
can resolve a lat/lng to one, and deriving it from park cells was measured at
21.3% ambiguous. This is the Pokémon GO / Ingress answer — the grid IS the
region.

`districtOf()` truncates the position's own tile; it must NEVER call
`latLngToCell(lat, lng, 7)` directly. H3's hierarchy is index truncation, not
geometry, so those differ near a boundary and a runner would be shown a
district their own tiles fall outside of. Monterrey happens to agree either
way, so this only shows up in other cities — a test asserts it across eight
base cells worldwide.

- **Board 1, CONQUEST** (`districtConquest`) — share of the ground *anyone
  holds* in the district. Changes hands the moment somebody else runs there.
  Ranked by cells held. The denominator is claimed ground, not the district's
  own 16 807 cells: that was measured at 0.02-2.39% for every real runner and
  never moves. How much of the district is untouched is a separate caption.
- **Board 2, LOCAL LEADERS** (`src/lib/mayorship.ts`) — mayorship per CELL,
  by distinct days present in a trailing 30. One point per day, so nobody
  buys a title with one huge Sunday; ties hold with the incumbent. Cannot be
  taken in a single visit.

**Nothing is ever named.** User-created `areas` were deleted outright — the
prompt, the overlap-suggest, the delete window, every string. Board 2's unit
is the grid, so a park and "a street block near my house" work through the
same code with no special case, and areas EMERGE from contiguous held cells.
Do not revive `areas` in any form.

**The leaderboard depends on no hand-applied migration, deliberately.** See
`leaderboard.ts`'s header: a board reading 0% because nobody ran the SQL is
indistinguishable from one reading 0% because nobody ran.

## Gotchas this repo has actually shipped

- **`park_path_cells` is EMPTY in production.** The schema migration ran; the
  36,193-row data migration (`20260908211500_park_paths_data.sql`) never did.
  So "Park-path progress per municipio" renders nothing — the RPC returns
  `[]`, not an error. Apply it by hand. This is the standing failure mode
  here: an unapplied migration reads as an honest `0`.
- **A ref cannot wake an effect.** `track-map.web.tsx` gated eight effects on
  a `readyRef`; two of them depended only on `active` and so never ran at all
  when a session started before the map loaded — silently removing the
  camera's browse hold. Readiness is state now. When gating an effect on
  readiness, ask what re-runs it.
- **`npm run measure-holes`** — read-only, anon key. Reports the size
  distribution of holes in every runner's covered ground and what the shipped
  `noiseHoles()` would fill. Run it before changing `MAX_NOISE_HOLE_CELLS`;
  the cap sits in a measured gap (nothing between 3 cells / 56 m and 9 cells
  / 110 m) and a different city could move it.
- **`holesOf()` is the ONE hole pipeline.** `enclosedCells` is it flattened,
  `noiseHoles` is it capped, `measure-holes` reports on it. Three copies
  existed briefly; `gap-policy.ts` exists only because two places once
  applied the same caps themselves and disagreed.
- **Measure a denominator against production before shipping a percentage.**
  Two denominators for one number were written down as decided and then
  measured to be unusable. A percentage is a claim about a denominator.

## Project shape

React Native + Expo (SDK 57, expo-router, TypeScript). `npx expo start`, then
Expo Go on device — no store builds. Bilingual, Spanish default
(`src/lib/i18n.tsx`). Local-first, no backend: bundled seed refreshed from
GitHub on open, SQLite saved list (`src/lib/db.ts`), `expo-calendar`,
`react-native-webview` for sponsor checkout. Web preview auto-deploys to
runningapp.pmarroquin.com on push to `main`.

For discovery of *new* races (adding a city, refreshing a calendar), use the
`race-research` skill — that's a different job from this pre-race verification.
