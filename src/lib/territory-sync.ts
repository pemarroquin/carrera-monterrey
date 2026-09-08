// Uploads a finished run to Supabase. Everything here is best-effort: this
// app has worked offline-first from day one (races.ts falls back to the
// bundled seed, saved.tsx tolerates blocked storage), and a run the runner
// just finished must never be lost to a dead network — so a failed upload
// is reported to the caller as a value, never thrown, and the run stays on
// screen for a manual retry.
import type { MultiPolygon, Polygon } from 'geojson';
import type { Session } from '@supabase/supabase-js';

import { ensureSession, supabase, TERRITORY_ENABLED } from '@/lib/supabase';
import type { LeaderboardRun, TileOwnerRow } from '@/lib/leaderboard';
import { isReservedNickname } from '@/lib/nickname';
import { setCachedDisplayName } from '@/lib/profile-cache';
import { nearestRegion } from '@/lib/regions';
import type { FenceResult, LatLng } from '@/lib/territory';
import { isCurrentTileRes, pathToTiles, tileResLikePattern } from '@/lib/tiles';
import type { TrackPoint } from '@/lib/tracking';

/** Every outcome type below is this same shape with a different `ok: true`
 *  payload — `{ ok: true, ...payload } | { ok: false, reason: ... }`. `R` is
 *  an extra, caller-specific failure reason on top of the three every call
 *  site shares (`deleteRun` uses it for `'denied'`) — defaults to `never` so
 *  every other caller's type is unaffected. */
type Outcome<T, R extends string = never> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | R };

/**
 * Every exported function in this file opened with the identical
 * TERRITORY_ENABLED / ensureSession guard, then wrapped its Supabase calls in
 * a try/catch that folded any thrown error into `{ reason: 'network' }` —
 * six copies of the same skeleton (2026-09-01 review finding). Factored here
 * so the failure taxonomy lives in exactly one place: the next sync function
 * — or a fix to this one, e.g. a future 'maintenance' reason — only has to
 * change this function, not remember to touch every call site by hand.
 *
 * `fn` still owns its own internal errors (a `{ ok: false, reason: 'network' }`
 * for a specific failed step, same as before) — this only removes the
 * boilerplate that was IDENTICAL across every caller. `R` lets a specific
 * caller report one extra reason beyond 'network' without widening every
 * other caller's type (see `deleteRun`'s 'denied').
 *
 * Exported (2026-09-03) so account.ts's email-link/sign-in functions share
 * the exact same guard rather than a second hand-copy of it — the whole
 * point of factoring this out in the first place.
 */
export async function withSession<T, R extends string = never>(
  fn: (session: Session) => Promise<({ ok: true } & T) | { ok: false; reason: 'network' | R }>,
): Promise<Outcome<T, R>> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  try {
    return await fn(session);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export interface RunUpload {
  points: TrackPoint[];
  fence: FenceResult;
  distanceM: number;
  startedAt: number;
  endedAt: number;
  /**
   * Ground this run SURROUNDED, already filtered for the privacy zone.
   *
   * Computed by the caller, not here, and that is deliberate: enclosure has
   * to be derived from the UNMASKED path (masking trims the very section
   * that closes a loop for anyone who starts and finishes at home), and the
   * unmasked path never leaves the device. index.tsx computes it where the
   * full path exists, drops the cells inside the zone at that run's own
   * jittered cut, and passes only the survivors here. See enclosure.ts.
   *
   * Optional so an entry already sitting in the retry queue from a previous
   * app version — persisted without this field — still uploads, just
   * without its enclosure.
   */
  enclosedCells?: string[];
}

/**
 * Outcome of claiming this run's tiles. `null` (never on the success path
 * below — see claimTiles) means the CALL itself never completed, distinct
 * from `{ claimedCount: 0, ... }`, which means it completed and genuinely
 * claimed nothing (an empty path, or every cell already owned).
 */
export interface TileClaimResult {
  /** Cells this run claimed for the FIRST time — ground nobody held. */
  claimedCount: number;
  /** Cells TAKEN from another runner: they held it, this run finished later.
   *  Separate from claimedCount because "new ground" and "ground won off
   *  someone" are different achievements and the summary says so. */
  takenCount: number;
  /** Cells this run covered and did NOT get, because the tile is held by a
   *  run that finished LATER than this one. The honest count behind "you ran
   *  here and it still isn't yours" — most often a stale upload landing after
   *  someone else's newer run. */
  skippedOlder: number;
  /** Cells this run's path crossed that are STILL someone else's after the
   *  claim ran. Under conquest that has exactly one cause: the holder's run
   *  finished LATER than this one, so this run could not take it (see
   *  claim_run_tiles' `where excluded.claimed_at > t.claimed_at`). It is no
   *  longer "an existing owner never loses a tile" — they do, to anyone who
   *  runs there more recently. Kept as `rival*` rather than the old enclosure
   *  model's real "took N m² off M runners" transfer (Phase 3's
   *  ST_Difference actually reassigned ground). Naming it `rival*` rather
   *  than reusing `spoils`/`taken*` is deliberate — see index.tsx and the
   *  executor's report on this brief. */
  rivalTiles: number;
  /** Distinct rival owners among rivalTiles, not run count — matches
   *  RunSpoils.runnersAffected's existing "count people, not events" call. */
  rivalRunners: number;
  /** The h3 ids behind rivalTiles — brief §5's "rival-owned tiles in a
   *  muted neutral" on the session-end map (fence-map.tsx/.web.tsx). Empty
   *  whenever rivalTiles is 0. Not plumbed to the LIVE map (track-map.tsx/
   *  .web.tsx): this only exists once claimTiles() resolves, after the run
   *  ends — a live equivalent would need its own query design (how often,
   *  against which cells) that's out of scope this pass, see the executor's
   *  report. */
  rivalCells: string[];
}

export type TileClaimOutcome =
  | { ok: true; result: TileClaimResult }
  // 'tooOld': the run finished outside the claim window, so it saved but
  // took no ground. A distinct reason because it is the one failure here
  // that is neither a bug nor an accusation — the runner did nothing wrong,
  // the upload simply arrived too late to compete, and the UI has to be able
  // to say that rather than implying either.
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'rejected' | 'tooOld' };

/**
 * Distinctive prefix the §2.5 forgery-guard trigger's RAISE EXCEPTION
 * carries (see supabase/migrations/20260903120000_tile_coverage.sql) — how
 * claimTiles tells "the DB genuinely rejected this batch as implausible"
 * apart from an ordinary network/Postgres error, which is worth a different
 * reason code precisely because retrying a rejected batch can never
 * succeed (unlike a network blip).
 */
const FORGERY_GUARD_MARKER = 'TILE_FORGERY_GUARD';

/**
 * Writes this run's `tile_visits` rows and claims whichever of its cells
 * are still unowned — brief §2/§2.5/§3. Two separate statements, in order,
 * because the forgery guard lives on `tile_visits` (the visit log, "not
 * speculative" per the brief) and must reject BEFORE any territory_tiles
 * row is touched: a rejected batch must claim nothing, not partially claim
 * whatever happened to run before the guard fired.
 *
 * First-to-claim is the `territory_tiles.h3` PRIMARY KEY plus `upsert(...,
 * { ignoreDuplicates: true })` — Postgres's ON CONFLICT DO NOTHING. This
 * function never re-checks or re-implements that rule in TypeScript (brief
 * §2: "do not reimplement this check").
 *
 * Called from uploadRun (below) for a fresh save, and by upload-queue.ts's
 * retry flow for free — both share the one `uploadRun` call, so a run that
 * failed and later succeeded on retry gets its tiles claimed exactly once,
 * the same run this whole function guards against double-claiming already
 * (a duplicate run row would double-claim; uploadRun's own retry-queue
 * bookkeeping is what prevents the run row itself from being inserted
 * twice — see uploadRun's callers in index.tsx).
 */
/** Marker in the claim function's "too old to claim" exception. Matched on
 *  text because plpgsql raises all of these with the generic P0001 code. */
const CLAIM_TOO_OLD_MARKER = 'CLAIM_TOO_OLD';
/** Marker for a run claiming more tiles than its distance could enclose. */
const CLAIM_IMPLAUSIBLE_MARKER = 'CLAIM_IMPLAUSIBLE';
/** Marker for a run claiming ground outside the path it actually recorded
 *  (20260908030000). Grouped with the other two as 'rejected' rather than
 *  given its own runner-facing reason: all three mean "the server did not
 *  believe this claim", and an honest client cannot produce any of them. */
const CLAIM_OFF_PATH_MARKER = 'CLAIM_OFF_PATH';

export async function claimTiles(
  runId: string,
  cells: string[],
  regionId: string | null,
  /**
   * Ground this run SURROUNDED but never crossed (enclosure.ts). Owned, not
   * visited — and that distinction is load-bearing in two directions:
   *
   *  - `tile_visits` stays a truthful log of ground actually run over, so
   *    the plausibility trigger that bounds a run's tiles against its
   *    distance keeps working unmodified. Enclosure deliberately claims far
   *    more tiles than the distance covers; writing them as visits would
   *    trip that guard and REJECT every loop run outright.
   *  - the trade is that claims are no longer fully covered by that guard.
   *    Stated plainly rather than hidden: the same caveat the guard already
   *    carries about targeted forgery (see the tile_coverage migration).
   */
  enclosed: string[] = [],
): Promise<TileClaimOutcome> {
  return withSession<{ result: TileClaimResult }, 'rejected' | 'tooOld'>(async (session) => {
    if (cells.length === 0) {
      return {
        ok: true,
        result: { claimedCount: 0, takenCount: 0, skippedOlder: 0, rivalTiles: 0, rivalRunners: 0, rivalCells: [] },
      };
    }

    // ONE server-side call, not three client statements.
    //
    // Conquest cannot be expressed from here: "take this tile only if my run
    // finished later than the run holding it" is a conditional upsert, and
    // PostgREST has no way to send that WHERE clause. It also should not be
    // expressed from here — the window, the future-date check and the claim
    // bound are rules about what a client is allowed to assert, so they
    // belong somewhere the client cannot argue with them. See
    // supabase/migrations/20260908010000_conquest.sql.
    //
    // The function writes tile_visits for `cells` only and territory_tiles
    // for cells + enclosed, so the plausibility trigger still bounds a run's
    // VISITS against its distance while enclosure claims more ground than
    // distance covers. Same split as before, now enforced server-side.
    const { data: claimRows, error: claimError } = await supabase.rpc('claim_run_tiles', {
      p_run_id: runId,
      p_visited: cells,
      p_enclosed: enclosed,
      p_region: regionId,
    });

    if (claimError) {
      // Our own RAISE EXCEPTION text arrives as `message`. Matched by marker
      // rather than SQLSTATE: plpgsql's plain `raise exception` uses the
      // generic P0001 for all of these, which cannot tell them apart.
      const message = claimError.message ?? '';
      if (
        message.includes(FORGERY_GUARD_MARKER) ||
        message.includes(CLAIM_IMPLAUSIBLE_MARKER) ||
        message.includes(CLAIM_OFF_PATH_MARKER)
      ) {
        return { ok: false, reason: 'rejected' };
      }
      if (message.includes(CLAIM_TOO_OLD_MARKER)) return { ok: false, reason: 'tooOld' };
      return { ok: false, reason: 'network' };
    }

    // returns table(...) comes back as an array of one row.
    const row = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
      | { claimed: number; taken: number; skipped_older: number }
      | undefined;
    const claimedCount = row?.claimed ?? 0;
    const takenCount = row?.taken ?? 0;
    const skippedOlder = row?.skipped_older ?? 0;

    // Rival tiles: ground this run crossed that is STILL someone else's now
    // that the claim has run — i.e. held by a run that finished later than
    // this one. Under conquest that is the only way to cross a tile and not
    // own it, which is exactly the `skipped_older` count above; this read
    // exists to get the cell IDS for the map, not the number.
    let rivalTiles = 0;
    let rivalRunners = 0;
    const rivalCells: string[] = [];
    if (skippedOlder > 0) {
      const { data: existing } = await supabase
        .from('territory_tiles')
        .select('h3, owner_id')
        .in('h3', cells);
      if (existing) {
        const owners = new Set<string>();
        for (const tile of existing) {
          if (tile.owner_id !== session.user.id) {
            rivalTiles++;
            rivalCells.push(tile.h3);
            owners.add(tile.owner_id);
          }
        }
        rivalRunners = owners.size;
      }
      // A failed read here just under-reports rivalTiles/rivalRunners/
      // rivalCells as 0/[] — the claim itself already happened and is not
      // affected.
    }

    return {
      ok: true,
      result: { claimedCount, takenCount, skippedOlder, rivalTiles, rivalRunners, rivalCells },
    };
  });
}

export type SyncOutcome =
  | {
      ok: true;
      runId: string;
      tiles: TileClaimResult | null;
      /** Why `tiles` is null, when it is. The run SAVED either way — this
       *  only explains the claim. 'tooOld' in particular is not a failure
       *  the runner caused, and the summary must not describe it as one. */
      tilesReason?: 'tooOld' | 'rejected' | 'network';
    }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Inserts one run, then claims its tiles. Returns a discriminated outcome
 * rather than a bare boolean so the UI can say something true about *why*
 * it failed — a silent `catch {}` here would make "sync is off" and "sync
 * broke" look identical on screen, which is exactly the failure this
 * codebase has been bitten by before.
 *
 * `tiles: null` in a successful outcome means the run itself saved but tile
 * claiming did not complete (network hiccup right after the run insert, or
 * the §2.5 forgery guard rejected the batch) — deliberately NOT folded into
 * an overall `ok: false`. The run row is real and must stay saved (same
 * "never punish the save" posture as flag_implausible_speed); re-running
 * uploadRun for the SAME run to retry the claim would insert a SECOND runs
 * row (see upload-queue.ts's own duplicate-upload guard), which is worse
 * than a run that claimed zero tiles. This IS a real, known gap: a run
 * whose claim fails on a transient network error today gets no automatic
 * retry of the claim alone. Untested by anything in this PR's gates — see
 * the executor's report.
 */
export async function uploadRun(run: RunUpload): Promise<SyncOutcome> {
  return withSession<{ runId: string; tiles: TileClaimResult | null }>(async (session) => {
    const first = run.points[0];
    const region = first ? nearestRegion(first.lat, first.lng)?.id ?? null : null;

    // The profile row is what `runs.user_id` references, and an anonymous
    // user has none until we make one — upsert (not insert) because the
    // second run from the same device would otherwise collide on the PK.
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ id: session.user.id }, { onConflict: 'id' });
    if (profileError) return { ok: false, reason: 'network' };

    const { data, error } = await supabase
      .from('runs')
      .insert({
        user_id: session.user.id,
        region,
        started_at: new Date(run.startedAt).toISOString(),
        ended_at: new Date(run.endedAt).toISOString(),
        distance_m: Math.round(run.distanceM),
        duration_s: Math.round((run.endedAt - run.startedAt) / 1000),
        raw_path: run.points.map((p) => [p.lat, p.lng, p.ts]),
        // PostGIS accepts GeoJSON geometry as text for a geometry column.
        // Still written every upload — buildFence/area_m2 are NOT deleted
        // by the tile model (brief §4: "do not delete anything in this
        // commit"), just no longer what map rendering or the leaderboard
        // read from. Kept for audit/comparison until a real run has proven
        // tiles out.
        fence: JSON.stringify(run.fence.geometry.geometry),
        area_m2: Math.round(run.fence.areaM2),
      })
      .select('id')
      .single();

    if (error || !data) return { ok: false, reason: 'network' };

    // Tiles: computed from the SAME masked path buildFence used for the
    // (still-written) fence column above — privacy-zone trimming applies to
    // ground claimed exactly as it applies to ground enclosed. See tiles.ts
    // §3 for why this isn't a naive per-fix conversion.
    const cells = pathToTiles(run.points).cells;
    // Enclosure comes in already computed and already zone-filtered — see
    // RunUpload.enclosedCells for why it cannot be derived here.
    const claim = await claimTiles(data.id, cells, region, run.enclosedCells ?? []);
    return {
      ok: true,
      runId: data.id,
      tiles: claim.ok ? claim.result : null,
      // 'disabled'/'auth' cannot reach here — uploadRun already passed the
      // same withSession guard to insert the run above.
      tilesReason: claim.ok ? undefined : (claim.reason as 'tooOld' | 'rejected' | 'network'),
    };
  });
}

export type DeleteOutcome =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'denied' };

/**
 * Deletes one of this device's own runs. Same non-throwing, best-effort
 * contract as every other function here.
 *
 * CRITICAL: as of this writing there is NO delete policy on `runs` — the
 * Phase 1 migration (20260826222037_territory_mode.sql) only ever granted
 * "runs: read all" and "runs: insert own". Under Postgres RLS, a DELETE
 * that matches no policy deletes ZERO rows and Postgres reports NO error —
 * so `.delete().eq('id', runId)` alone would report {ok:true} while
 * touching nothing, which is exactly the silent-no-op this codebase has a
 * standing rule against (never report unverified success). Chaining
 * `.select('id')` on the delete makes Postgres return the rows it actually
 * removed, and an empty result is treated as a failure, not a success —
 * this is the ONLY way to tell "deleted" from "matched nothing" apart, since
 * both otherwise come back as `{ error: null }`.
 *
 * See supabase/migrations/<timestamp>_runs_delete_own.sql for the (currently
 * UNAPPLIED) policy that will make this actually work. Until Pedro applies
 * it by hand, every call here correctly reports `{ ok: false, reason:
 * 'denied' }` — a true, distinct failure, not folded into 'network'. That
 * distinction matters to the caller: a 'network' failure implies "try
 * again, it might work"; a zero-row delete with no Postgres error never will
 * until the policy lands, no matter how many times it's retried.
 */
export async function deleteRun(runId: string): Promise<DeleteOutcome> {
  // `unknown`, not `Record<string, never>` — withSession intersects this
  // with `{ ok: true }` to build the success shape, and Record<string,
  // never>'s index signature makes `ok: true` impossible to intersect with
  // it (every key would have to be `never`). `unknown` is the intersection
  // identity (`{ ok: true } & unknown` is just `{ ok: true }`), which is
  // exactly "no extra success fields" — deleteRun has nothing to report
  // beyond ok/fail, unlike uploadRun's `runId`.
  return withSession<unknown, 'denied'>(
    async (session): Promise<{ ok: true } | { ok: false; reason: 'network' | 'denied' }> => {
      const { data, error } = await supabase
        .from('runs')
        .delete()
        .eq('id', runId)
        // Redundant with the eventual RLS policy (auth.uid() = user_id), but
        // cheap and explicit: this call must never even ATTEMPT to delete a
        // row it doesn't own, policy or no policy.
        .eq('user_id', session.user.id)
        .select('id');

      if (error) return { ok: false, reason: 'network' };
      // No error AND no rows: RLS matched no policy (or the row belongs to
      // someone else). Distinct from a network blip — see the doc comment.
      if (!data || data.length === 0) return { ok: false, reason: 'denied' };
      return { ok: true };
    },
  );
}

/** One previously-captured fence, ready to draw. */
export interface MyFence {
  id: string;
  /** Epoch ms of the run's start — feeds fenceColorForRun, so the fence
   *  renders in the same colour set everywhere. */
  startedAtMs: number;
  /**
   * Null when the run has been FULLY taken by other runners — Phase 3's
   * trigger nulls the fence and zeroes the area rather than deleting the
   * row, because it is still history ("this run happened, then it was
   * overtaken"). Distinct from a parse failure: the row is intact and
   * correct, there is simply no ground left to draw.
   */
  geometry: Polygon | MultiPolygon | null;
  /**
   * The actual recorded path (already privacy-masked at upload — see
   * parseRawPath), for drawing the run's real route rather than the fence
   * polygon's boundary (the bug `1df2ae6` fixed for the summary map, here
   * for the Saved tab). Null whenever `raw_path` is missing or unparseable —
   * a card with a good fence but no route still renders, just without the
   * route line; this must NOT bump `skipped`, same defensive posture as the
   * null-fence case below.
   */
  route: LatLng[] | null;
  areaM2: number;
  distanceM: number;
  /** m² other runners have carved out of this run since it was saved. */
  lostM2: number;
  /** Set by the server-side speed trigger. A flagged run still counts and
   *  still holds territory — it is marked, not punished. Never treat it as
   *  proof of cheating; see 20260827_anti_cheat_flag.sql. */
  flagged: boolean;
  /** Which check tripped ('speed:claimed' | 'speed:path' | 'speed:segment'),
   *  so the UI can say what was implausible rather than showing a bare
   *  warning. */
  flagReason: string | null;
}

export type FencesOutcome =
  | { ok: true; fences: MyFence[]; skipped: number }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * PostGIS ≥3 registers geometry→json casts, so PostgREST serialises the
 * `fence` column as a GeoJSON object. Verified defensively rather than
 * trusted: anything that isn't a usable (Multi)Polygon object is skipped AND
 * counted, so a serialisation surprise shows up as `skipped > 0` instead of
 * as a silently empty map.
 *
 * Exported for tests only — this is the single gate every saved territory
 * has to pass before it can be drawn, and production rows carry a shape
 * that's easy to get wrong from memory: PostGIS/PostgREST serialise the
 * column as `{ type, crs, coordinates }`, with a `crs` member GeoJSON
 * itself dropped back in RFC 7946. A parser tightened to accept only
 * `{type, coordinates}` would reject every real row and empty the
 * Territories map with no error anywhere. test/territory-sync.test.ts
 * pins both real payload shapes against that.
 */
export function parseFenceGeometry(value: unknown): Polygon | MultiPolygon | null {
  // Older PostgREST/PostGIS combinations return geometry as a string (WKB
  // hex, or GeoJSON text); the JSON-text case is recoverable.
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const g = value as { type?: unknown; coordinates?: unknown };
  if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
    return g as unknown as Polygon | MultiPolygon;
  }
  return null;
}

/**
 * `raw_path` is written on upload as `run.points.map((p) => [p.lat, p.lng,
 * p.ts])` (see uploadRun above) — already privacy-masked by then
 * (privacy-zone.ts trims the start/end before it ever reaches uploadRun), so
 * there is nothing left to mask here, only to parse back defensively.
 * PostgREST serialises a `jsonb` column as a real JSON value, so this is
 * ordinarily an array already; the string branch covers the same
 * older-stack case parseFenceGeometry guards against. Anything that isn't a
 * clean array of `[lat, lng, ts]` triples returns null rather than throwing
 * or drawing a corrupted line.
 */
export function parseRawPath(value: unknown): LatLng[] | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;

  const points: LatLng[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const [lat, lng] = entry;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    points.push({ lat, lng });
  }
  return points;
}

/**
 * Every fence this device's (anonymous) identity has captured, newest first.
 * Same outcome-as-value contract as uploadRun, and for the same reason: the
 * callers render "why" (disabled/auth/network), never a bare empty list that
 * could mean anything.
 */
export async function fetchMyFences(): Promise<FencesOutcome> {
  return withSession<{ fences: MyFence[]; skipped: number }>(async (session) => {
    const { data, error } = await supabase
      .from('runs')
      .select('id, started_at, distance_m, area_m2, fence, raw_path, flagged, flag_reason')
      .eq('user_id', session.user.id)
      .order('started_at', { ascending: false });

    if (error || !data) return { ok: false, reason: 'network' };

    const fences: MyFence[] = [];
    let skipped = 0;
    for (const row of data) {
      const startedAtMs = Date.parse(row.started_at);
      // A NULL fence is a fully-overtaken run, which is real history and
      // must be kept. Only a fence that is present but unreadable, or an
      // unparseable timestamp, counts as skipped — conflating the two made
      // Phase 3's own outcome look like corrupt data.
      const geometry = row.fence === null ? null : parseFenceGeometry(row.fence);
      if (Number.isNaN(startedAtMs) || (row.fence !== null && geometry === null)) {
        skipped++;
        continue;
      }
      // A bad/missing raw_path is common (older rows predate this feature)
      // and must not count toward `skipped` — that field means "fence
      // present but unreadable, or a bad timestamp," not "no route line."
      const route = parseRawPath(row.raw_path);
      fences.push({
        id: row.id,
        startedAtMs,
        geometry,
        route,
        areaM2: Number(row.area_m2) || 0,
        distanceM: Number(row.distance_m) || 0,
        lostM2: 0, // filled in below
        flagged: row.flagged === true,
        flagReason: row.flag_reason ?? null,
      });
    }

    // How much ground each of these runs has lost to other runners. One
    // extra query rather than a join: the embed would need the FK
    // constraint's generated name, which is brittle to rename.
    if (fences.length > 0) {
      const { data: events } = await supabase
        .from('territory_events')
        .select('loser_run_id, area_taken_m2')
        .in(
          'loser_run_id',
          fences.map((f) => f.id),
        );
      if (events) {
        const lostByRun = new Map<string, number>();
        for (const e of events) {
          lostByRun.set(
            e.loser_run_id,
            (lostByRun.get(e.loser_run_id) ?? 0) + (Number(e.area_taken_m2) || 0),
          );
        }
        for (const fence of fences) fence.lostM2 = lostByRun.get(fence.id) ?? 0;
      }
      // A failure here leaves lostM2 at 0 rather than failing the whole
      // fetch: the fences themselves are the point, the loss annotation is
      // a garnish.
    }

    return { ok: true, fences, skipped };
  });
}

/** What one run took from other runners — Phase 3's payoff, read back after
 *  the upload so the summary can report it. */
export interface RunSpoils {
  areaTakenM2: number;
  /** Distinct runners who lost ground, not runs — losing 3 fences to one
   *  person reads as one rivalry, not three. */
  runnersAffected: number;
  runsAffected: number;
}

export type SpoilsOutcome =
  | { ok: true; spoils: RunSpoils }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Territory this run carved out of other runners' fences.
 *
 * Reads `territory_events`, which ONLY the Phase 3 trigger writes — so an
 * empty result is the honest "you overlapped nobody", not a missing feature.
 * Safe to call before the trigger migration is applied: the table exists
 * from Phase 1 and simply stays empty.
 */
export async function fetchRunSpoils(runId: string): Promise<SpoilsOutcome> {
  return withSession<{ spoils: RunSpoils }>(async () => {
    const { data: events, error } = await supabase
      .from('territory_events')
      .select('loser_run_id, area_taken_m2')
      .eq('winner_run_id', runId);

    if (error || !events) return { ok: false, reason: 'network' };
    if (events.length === 0) {
      return { ok: true, spoils: { areaTakenM2: 0, runnersAffected: 0, runsAffected: 0 } };
    }

    const areaTakenM2 = events.reduce((sum, e) => sum + (Number(e.area_taken_m2) || 0), 0);
    const loserRunIds = events.map((e) => e.loser_run_id);

    // Second hop to turn runs into people. If it fails, fall back to the
    // run count rather than reporting 0 runners against a real area — a
    // number that contradicts itself is worse than a coarse one.
    const { data: losers } = await supabase
      .from('runs')
      .select('user_id')
      .in('id', loserRunIds);

    const runnersAffected = losers
      ? new Set(losers.map((r) => r.user_id)).size
      : loserRunIds.length;

    return {
      ok: true,
      spoils: { areaTakenM2, runnersAffected, runsAffected: events.length },
    };
  });
}

export type TileTotalOutcome =
  | { ok: true; total: number }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * How many tiles this device's identity currently owns, optionally narrowed
 * to one region — the running Layer-1 "permanent progression" total (brief
 * §1.5), read back after a save so the summary screen can show it growing.
 * Deliberately a `count`-only query (`head: true`), not a row fetch — this
 * can run every time a run ends without downloading anything but a number.
 *
 * See index.tsx / the executor's report for why this is a raw count, not a
 * percentage: a true "% of San Pedro stomped" needs the brief §1's real
 * municipio + runnable-tile denominator, explicitly out of scope this pass.
 */
export async function fetchMyTileTotal(regionId: string | null): Promise<TileTotalOutcome> {
  return withSession<{ total: number }>(async (session) => {
    let query = supabase
      .from('territory_tiles')
      .select('h3', { count: 'exact', head: true })
      .eq('owner_id', session.user.id)
      // Only cells at the resolution this build claims at. Without it, any
      // not-yet-converted res-11 row still counts and the total reads high
      // — see isCurrentTileRes' doc. Done as a LIKE because this query
      // deliberately returns a count and never the cell strings.
      .like('h3', tileResLikePattern());
    if (regionId !== null) query = query.eq('region_id', regionId);

    const { count, error } = await query;
    if (error || count === null) return { ok: false, reason: 'network' };
    return { ok: true, total: count };
  });
}

export type LeaderboardOutcome =
  | { ok: true; runs: LeaderboardRun[]; meUserId: string; skipped: number }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Every run's fence + owner, for the leaderboard to aggregate on device (see
 * leaderboard.ts for why the union happens here rather than in SQL).
 *
 * `runs: read all` and `profiles: read all` are both open policies, so this
 * legitimately returns other people's fences — that is the feature. The
 * caller's own id comes back too, so a row can be marked as yours without a
 * second round-trip.
 */
export async function fetchLeaderboard(): Promise<LeaderboardOutcome> {
  return withSession<{ runs: LeaderboardRun[]; meUserId: string; skipped: number }>(async (session) => {
    // The embedded profile comes from runs.user_id's FK to profiles.id.
    // PostgREST returns it as an object (or null if the row is missing).
    const { data, error } = await supabase
      .from('runs')
      .select('user_id, region, fence, flagged, profiles(display_name)');

    if (error || !data) return { ok: false, reason: 'network' };

    const runs: LeaderboardRun[] = [];
    let skipped = 0;
    for (const row of data) {
      // A NULL fence means Phase 3 fully took this run's ground. It holds
      // nothing, so it correctly contributes nothing to the ranking — but
      // it is not corrupt, so it must not inflate `skipped`, which exists
      // to surface real parse failures.
      if (row.fence === null) continue;
      const geometry = parseFenceGeometry(row.fence);
      if (!geometry) {
        skipped++;
        continue;
      }
      // Depending on how PostgREST infers the relationship this arrives as
      // an object or a one-element array; normalise rather than trusting one.
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      runs.push({
        userId: row.user_id,
        displayName: profile?.display_name ?? null,
        region: row.region ?? null,
        geometry,
        flagged: row.flagged === true,
      });
    }
    return { ok: true, runs, meUserId: session.user.id, skipped };
  });
}

export type TileLeaderboardOutcome =
  | { ok: true; tiles: TileOwnerRow[]; meUserId: string; skipped: number }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Every claimed tile + its owner, for leaderboard.ts's rankByTileCount to
 * aggregate on device — same "aggregate client-side, fine at pilot scale"
 * posture as fetchLeaderboard above (leaderboard.ts's own header explains
 * why: PostgREST can't express a GROUP BY, and migrations here are applied
 * BY HAND so a Postgres aggregate function is a second thing to forget to
 * apply). Considerably CHEAPER than fetchLeaderboard's fence geometries
 * though — every row here is a short h3 string plus two ids, not a polygon.
 *
 * `territory_tiles.owner_id` references `auth.users(id)` directly (brief
 * §2's literal schema — see the migration), NOT `profiles(id)` the way
 * `runs.user_id` does, so PostgREST can't auto-embed `profiles(display_name)`
 * from this table the one-hop way fetchLeaderboard does. Same two-hop
 * pattern as fetchRunSpoils above: fetch the tiles, then fetch display names
 * for the distinct owner ids in one second query.
 */
export async function fetchTileLeaderboard(): Promise<TileLeaderboardOutcome> {
  return withSession<{ tiles: TileOwnerRow[]; meUserId: string; skipped: number }>(async (session) => {
    // The embedded `runs` comes from territory_tiles.claim_run_id's FK to
    // runs.id — the only FK from this table to `runs`, so PostgREST can
    // resolve `runs(flagged)` unambiguously the same way fetchLeaderboard
    // resolves `profiles(display_name)`.
    const { data, error } = await supabase
      .from('territory_tiles')
      // h3 is selected purely to filter on resolution — see the loop below.
      // A leaderboard that mixed resolutions would rank a runner with
      // unconverted res-11 tiles against runners counted in res-12 ones,
      // which is not one ranking at all.
      .select('h3, owner_id, region_id, runs(flagged)');

    if (error || !data) return { ok: false, reason: 'network' };

    const ownerIds = Array.from(new Set(data.map((row) => row.owner_id).filter((id): id is string => !!id)));
    let nameById = new Map<string, string | null>();
    if (ownerIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name')
        .in('id', ownerIds);
      if (profiles) nameById = new Map(profiles.map((p) => [p.id, p.display_name ?? null]));
      // A failed second query just leaves every displayName null (falls
      // back to "anonymous" in the UI) — the tile counts themselves, the
      // actual ranking, are unaffected. Same "the count is the point, the
      // name is a garnish" posture as fetchMyFences' lostM2.
    }

    const tiles: TileOwnerRow[] = [];
    let skipped = 0;
    for (const row of data) {
      if (!row.owner_id) {
        skipped++;
        continue;
      }
      // Not counted and NOT counted as skipped: `skipped` reports rows that
      // are malformed, and an unconverted tile is intact — it simply
      // belongs to the previous resolution. Lumping it in would make the
      // pre-migration window look like data corruption.
      if (!isCurrentTileRes(row.h3)) continue;
      // Same normalise-object-or-array defensiveness as fetchLeaderboard's
      // `profiles` embed — depends on how PostgREST infers the relationship.
      const runRel = Array.isArray(row.runs) ? row.runs[0] : row.runs;
      tiles.push({
        ownerId: row.owner_id,
        displayName: nameById.get(row.owner_id) ?? null,
        regionId: row.region_id ?? null,
        flagged: runRel?.flagged === true,
      });
    }
    return { ok: true, tiles, meUserId: session.user.id, skipped };
  });
}

export type ProfileOutcome =
  | { ok: true; displayName: string | null }
  // 'taken' and 'reserved' are specific to updateDisplayName — a nickname is
  // this app's identity, so "someone already has it" and "nobody may have
  // it" are things the runner can ACT on, and must not collapse into the
  // generic 'network' failure that tells them to check their connection.
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'taken' | 'reserved' };

/** This device's own profile row (anonymous identity — see supabase.ts). */
export async function fetchMyProfile(): Promise<ProfileOutcome> {
  return withSession<{ displayName: string | null }>(async (session) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', session.user.id)
      .maybeSingle();

    // maybeSingle, not single: the profile row is only created on the first
    // run upload, so "no row yet" is the normal state for a new install and
    // must not read as an error.
    if (error) return { ok: false, reason: 'network' };
    const displayName = (data?.display_name ?? null) as string | null;
    // Cached here rather than at each call site so every reader benefits —
    // this screen, NamePrompt, and anything added later — without having to
    // remember to. See profile-cache.ts for why the name is worth keeping.
    setCachedDisplayName(displayName);
    return { ok: true, displayName };
  });
}

/** Longer names get truncated in every row that renders them; cap at the
 *  source so what's stored is what's shown. */
export const DISPLAY_NAME_MAX = 24;

/**
 * Sets the name shown on the leaderboard. Upserts because a runner may pick
 * a name before ever finishing a run, i.e. before uploadRun has created the
 * profile row.
 */
export async function updateDisplayName(name: string): Promise<ProfileOutcome> {
  // 'taken' | 'reserved' as the extra reasons R — the same mechanism
  // deleteRun uses for its 'denied', so these two stay off every OTHER
  // ProfileOutcome caller's type.
  return withSession<{ displayName: string | null }, 'taken' | 'reserved'>(async (session) => {
    const trimmed = name.trim().slice(0, DISPLAY_NAME_MAX);
    // An empty string would render as a nameless row; store a real null so
    // the UI's "anonymous" fallback is the single code path for "no name".
    const value = trimmed.length > 0 ? trimmed : null;

    // Checked before the round trip, and only for a real name — clearing
    // your nickname back to Anonymous is always allowed.
    if (value !== null && isReservedNickname(value)) return { ok: false, reason: 'reserved' };

    const { error } = await supabase
      .from('profiles')
      .upsert({ id: session.user.id, display_name: value }, { onConflict: 'id' });
    // 23505 is Postgres' unique_violation, raised here by
    // profiles_display_name_unique_idx: someone else holds this nickname.
    // Matched by CODE, never by the error message — that text carries the
    // index name and is not a stable contract.
    //
    // If that migration has not been applied yet this branch simply never
    // fires and duplicates save as they always did: the honest failure mode
    // for an unapplied migration in this repo (they are all applied by
    // hand), and it fails OPEN — nobody is blocked from saving a name by a
    // rule the database is not enforcing.
    if (error?.code === '23505') return { ok: false, reason: 'taken' };
    if (error) return { ok: false, reason: 'network' };
    // Only after the server confirmed it — caching an unsaved name would
    // show the runner a value that isn't on the leaderboard.
    setCachedDisplayName(value);
    return { ok: true, displayName: value };
  });
}

export type VisitedOutcome =
  | { ok: true; cells: string[] }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Every cell this runner has ever physically covered.
 *
 * Reads `tile_visits`, and that choice is the whole feature. `tile_visits`
 * is an append-only log with no update or delete policy, so CONQUEST never
 * touches it: ground taken off you by a later run stays in your history
 * forever, because you did run there. `territory_tiles` answers "what do I
 * hold"; this answers "where have I been", and the two must not be the same
 * surface — that confusion is why the personal record moved off the live map
 * in the first place.
 *
 * Enclosed ground is deliberately absent. It is owned but was never run
 * over, and this is a record of places the runner has actually been.
 *
 * Paged rather than a single request: PostgREST caps a response at 1000 rows
 * by default, so a runner past that would silently see a truncated history
 * — a wrong answer that looks like a complete one.
 */
export async function fetchMyVisitedCells(): Promise<VisitedOutcome> {
  return withSession<{ cells: string[] }>(async (session) => {
    const PAGE = 1000;
    const seen = new Set<string>();

    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('tile_visits')
        .select('h3')
        .eq('user_id', session.user.id)
        // Ordered by the FULL primary key, not just h3. tile_visits is keyed
        // (h3, run_id), so the same cell appears once per run that crossed
        // it — ordering on h3 alone leaves those rows in an unspecified
        // order between pages, and offset paging can then skip one. A
        // skipped row is a cell missing from the runner's history with
        // nothing to indicate it.
        .order('h3', { ascending: true })
        .order('run_id', { ascending: true })
        .range(offset, offset + PAGE - 1);

      // A partial history is worse than none: it would draw a map missing
      // places the runner remembers going, with nothing to say why.
      if (error) return { ok: false, reason: 'network' };
      if (!data || data.length === 0) break;

      // The same cell appears once per run that crossed it — the log records
      // visits, not ground.
      for (const row of data) seen.add(row.h3);
      if (data.length < PAGE) break;
    }

    return { ok: true, cells: [...seen] };
  });
}
