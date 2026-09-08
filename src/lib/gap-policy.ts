// Shared gap plausibility policy — the ONE pair of caps that decide whether
// a GPS gap (missing fixes between two recorded points) is close enough to
// "a runner briefly out of GPS view" to act on, or far enough away that we
// must leave the hole alone.
//
// Before this module existed the two subsystems that each face this exact
// question disagreed with each other. tiles.ts already had these caps and
// used them to decide whether to draw gap-fill H3 cells across a gap.
// tracking.ts's distanceM accumulator used NO caps at all: a
// visibilitychange gap was ALWAYS excluded from distanceM regardless of how
// short or slow it was, while a GPS-stall gap of the identical physical
// shape (no visibilitychange fired, the watch stayed alive the whole time)
// was ALWAYS included, because tracking.ts never broke the leg for it. The
// 2026-09-02 geometry audit (see `Source Data/Outputs/Running App/Geometry
// Audit — Saved Runs vs Recomputed (2026-09-02).md`, one level above this
// repo) measured that disagreement directly on real saved runs: on run
// `68e32c11`, the tile builder bridged straight through a clean 76s/105.9m
// leg-break gap (105.9m is under MAX_BRIDGE_DISTANCE_M, 5.0 km/h is far
// under MAX_BRIDGE_SPEED_MS) while the recorder's distance total excluded
// that exact same chord. Same physical event, two different answers.
//
// Both subsystems now import the caps from here so they can never
// independently drift again. Do not fork a second copy of either number.
//
// IMPORTANT — this governs DISTANCE credit and TILE gap-fill only, never
// GEOMETRY. Crediting a gap's chord to a distance total is a scalar claim
// ("the runner covered at least this much ground in this much time"), which
// two real timestamped fixes and a straight-line lower bound support.
// Nothing here inserts a point into a recorded path or changes what
// buildFence() sees — that would fabricate territory nobody proved they
// held. See this repo's "never connect across a gap" rule.
import { haversineM, type LatLng } from '@/lib/territory';

/**
 * Fastest sustained human running speed the server's OWN anti-cheat
 * flagging already treats as implausible — reused rather than inventing a
 * second number, so every subsystem that judges "physically possible for a
 * runner" agrees. See supabase/migrations/20260827_anti_cheat_flag.sql:
 * `max_kmh constant numeric := 25` (marathon world record pace is ~21 km/h;
 * 25 is already generous).
 *
 * A gap whose implied speed exceeds this is never bridged and never
 * credited to distance.
 */
export const MAX_BRIDGE_SPEED_MS = (25 * 1000) / 3600; // ≈ 6.94 m/s

/**
 * Longest gap between two consecutive fixes treated as plausible at all,
 * even when the implied speed is a perfectly ordinary jog. This is a
 * SEPARATE question from MAX_BRIDGE_SPEED_MS (b8's review, 2026-09-01):
 * speed asks "was this physically possible" (catches a car, a GPS spoof, a
 * teleport); distance asks "do we know what path they took." A runner
 * really can cover 2km in 11 minutes (3.03 m/s — comfortably under the
 * speed cap) while their phone sat locked in a pocket the whole way.
 * Bridging a gap only knows how to draw a STRAIGHT LINE between the two
 * fixes, and the runner's real path followed streets the straight line can
 * cut through buildings, a river, or another runner's yard. Under
 * first-to-claim tile ownership that isn't merely generous — a wrongly
 * claimed tile is permanently taken from whoever actually ran it. For
 * distance credit the stakes are lower (a scalar total, not ownership) but
 * the same cap is reused rather than inventing a second, looser one for
 * distance alone — see this module's header.
 *
 * 150m: roughly three sampling intervals at the tracker's real fix spacing
 * (empirically ~30-50m apart at the 2s/3m throttle — see tracking.ts's
 * TIME_INTERVAL_MS/DISTANCE_INTERVAL_M and tiles.test.ts's own gap-fill test
 * fixtures). That comfortably absorbs one or two dropped fixes (a brief GPS
 * hiccup, a short tunnel) while staying far short of anything that could be
 * a real route deviation.
 */
export const MAX_BRIDGE_DISTANCE_M = 150;

export interface GapEvaluation {
  /** Straight-line distance between the gap's two endpoints, metres. This is
   *  the raw chord — present regardless of whether the gap is credited, so
   *  callers can keep instrumenting every gap even when this returns
   *  `credited: false`. */
  chordM: number;
  /** True when the gap passes BOTH shared caps (distance and implied speed)
   *  and is safe to act on: credit its chord to a distance total, or bridge
   *  it into contiguous tiles. False leaves the hole exactly as today. */
  credited: boolean;
}

/**
 * Evaluates a single GPS gap against the shared caps. Pure — no React, no
 * network, testable directly (see test/gap-policy.test.ts).
 *
 * Returns `null` when there is no prior point to chord against at all (a
 * gap that opened before any fix had ever been recorded) — there is nothing
 * to measure, let alone credit.
 */
export function evaluateGap(params: { from: LatLng | null; to: LatLng; dtMs: number }): GapEvaluation | null {
  const { from, to, dtMs } = params;
  if (!from) return null;

  const chordM = haversineM(from, to);
  // dtMs <= 0 (out-of-order or identical timestamps) can't imply a real
  // speed — treated as implausible rather than divided by zero/negative, so
  // a bad pair of timestamps fails safe (not credited) instead of silently
  // passing the check. Same reasoning as tiles.ts's own impliedSpeedMs
  // guard.
  const credited =
    dtMs > 0 && chordM <= MAX_BRIDGE_DISTANCE_M && chordM / (dtMs / 1000) <= MAX_BRIDGE_SPEED_MS;

  return { chordM, credited };
}

/** A point that can be tested against the caps: a position plus the fix's own
 *  timestamp. TrackPoint satisfies this, and so does anything else carrying
 *  the same two facts. */
export interface TimedPoint extends LatLng {
  ts: number;
}

/**
 * Splits a recorded path wherever a gap fails the caps — i.e. wherever
 * `evaluateGap` says the hole must be left alone.
 *
 * This is the RENDERING half of the same policy, and it exists because the
 * recorded `points` array is a single flat list with no record of its own
 * seams. tracking.ts breaks a leg on `visibilitychange` by nulling
 * `lastRef`, but that only stops DISTANCE accumulating — the point is still
 * appended to `points` like any other, so every consumer that draws from
 * that array joins the two sides of the gap with a straight line. On a real
 * iOS Safari run (reported with screenshots 2026-09-07) that produced a
 * chord running hundreds of metres from the start straight to the runner's
 * current position, plus the same chord doubled as the wall ribbon's two
 * edges.
 *
 * Note the direction this cuts. The module header above forbids using these
 * caps to ADD geometry — bridging a gap would fabricate ground nobody
 * proved they held. This does the opposite: it REMOVES a line that was
 * already being drawn across ground nobody recorded. Same rule, same
 * caps, and it makes the drawn route agree with the tiles that get claimed
 * (pathToTiles already refuses to bridge exactly these gaps), instead of
 * the route quietly claiming more than the tiles do.
 *
 * Returns one leg per contiguous run of points. A path with no failing gap
 * comes back as a single leg, so callers can treat the common case as
 * `legs[0]`. Empty input returns an empty array — no leg at all, rather
 * than one empty leg nobody can draw.
 */

/**
 * Share of a run's RECORDED distance that may be closed by guessing across
 * gaps, in total across every gap in the run.
 *
 * Why this exists at all: the app records only while it is in the
 * foreground. iOS Safari backgrounds it whenever the runner switches apps,
 * and Expo Go cannot hold a background-location task either (see CLAUDE.md's
 * Expo Go ceiling) — so a runner who opens Spotify mid-run loses ground they
 * genuinely covered. Strava can backfill from a watch; this cannot. Refusing
 * to bridge punishes the platform, not cheating. Measured on a real run
 * (2026-09-08): a deliberate 3.2 km block circuit scored ZERO enclosed tiles
 * because 7 background interruptions left ~198 m unrecorded and the ring
 * leaked.
 *
 * The stronger reason, and the one that makes it safe: under CONQUEST a
 * generous guess is no longer permanent. Whoever really ran that ground
 * takes it back by running it. The original objection to bridging — that a
 * wrong guess permanently steals from the runner who actually went there —
 * died with first-to-claim.
 *
 * Why a FRACTION of the run and not a flat metre count: a closure is a free
 * straight line, so the allowance is an exploit dial. Run a U shape,
 * background the app across the open end, and the loop closes around ground
 * never covered — the 977,565 m² auto-close bug at smaller scale. Tied to
 * recorded distance instead, the exploit has to be paid for: 198 m over a
 * 3.2 km walk is 6% and passes; 400 m over a 500 m "run" is 80% and does
 * not. Budget is spent across the WHOLE run, so five gaps cannot each take
 * 10%.
 *
 * MAX_BRIDGE_SPEED_MS still applies to every gap regardless of budget. No
 * platform-fairness argument covers 60 km/h — that is a car.
 */
export const GAP_CLOSURE_BUDGET_FRACTION = 0.1;

export interface GapPlan {
  /** Per segment i (from points[i-1] to points[i]), whether the path is
   *  continuous across it. Index 0 is always false — there is no segment
   *  before the first point. */
  bridged: boolean[];
  /** Distance across segments that needed no guessing, metres. */
  recordedM: number;
  /** Guessing allowance derived from recordedM. */
  budgetM: number;
  /** How much of that allowance the closures below actually consumed. */
  usedM: number;
  /** Gaps left open because the implied speed was impossible for a runner. */
  skippedSpeed: number;
  /** Gaps left open because the budget could not cover them. */
  skippedBudget: number;
}

/**
 * Decides, once per run, which gaps are closed and which are left as holes.
 *
 * ONE planner for every consumer. tiles.ts asks it what ground to claim and
 * the map components ask it where to break the drawn route — before this
 * they each applied the caps themselves, which is exactly how the recorder
 * and the tile builder came to disagree about the same physical gap (see
 * this module's header). Now they cannot: they read the same array.
 *
 * Two passes, because the budget is a fraction of the recorded distance and
 * that is not known until the whole path has been walked once.
 */
export function planGapClosures(points: TimedPoint[]): GapPlan {
  const bridged = new Array<boolean>(points.length).fill(false);
  if (points.length < 2) {
    return { bridged, recordedM: 0, budgetM: 0, usedM: 0, skippedSpeed: 0, skippedBudget: 0 };
  }

  // Pass 1 — what was genuinely recorded. Segments longer than
  // MAX_BRIDGE_DISTANCE_M are gaps and do not count toward the distance
  // that earns the allowance; otherwise a run could bankroll its own
  // guessing.
  let recordedM = 0;
  const spans: { distM: number; dtMs: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const distM = haversineM(points[i - 1], points[i]);
    spans.push({ distM, dtMs: points[i].ts - points[i - 1].ts });
    if (distM <= MAX_BRIDGE_DISTANCE_M) recordedM += distM;
  }

  const budgetM = recordedM * GAP_CLOSURE_BUDGET_FRACTION;

  // Pass 2 — spend it, nearest-first is not needed: gaps are taken in the
  // order they happened, which is the order the runner experienced them.
  let usedM = 0;
  let skippedSpeed = 0;
  let skippedBudget = 0;
  for (let i = 1; i < points.length; i++) {
    const { distM, dtMs } = spans[i - 1];

    // With no usable elapsed time, fall back to the DISTANCE rule alone
    // rather than calling it impossible.
    //
    // Treating dt <= 0 as infinite speed looks safe and is not: measured on
    // a real 3.2 km walk (2026-09-08), NINE segments were rejected as
    // "impossible speed" and every one of them was 0 metres in 0 seconds —
    // the tracker recording the same position twice on the same
    // millisecond. Moving 0 m is not suspicious, and the fallback still
    // refuses anything past MAX_BRIDGE_DISTANCE_M, so a genuine teleport
    // with a broken clock is still rejected. What it stops is an honest run
    // being told it contained nine impossible movements, and its drawn
    // route being cut into ten pieces for no reason.
    const impliedSpeedMs = dtMs > 0 ? distM / (dtMs / 1000) : 0;

    if (impliedSpeedMs > MAX_BRIDGE_SPEED_MS) {
      skippedSpeed += 1;
      continue;
    }
    if (distM <= MAX_BRIDGE_DISTANCE_M) {
      bridged[i] = true;
      continue;
    }
    if (usedM + distM <= budgetM) {
      bridged[i] = true;
      usedM += distM;
      continue;
    }
    skippedBudget += 1;
  }

  return { bridged, recordedM, budgetM, usedM, skippedSpeed, skippedBudget };
}

export function splitLegs<T extends TimedPoint>(points: T[]): T[][] {
  if (points.length === 0) return [];

  // Reads the shared plan rather than applying the caps itself, so the
  // drawn route breaks in exactly the places the claimed tiles leave holes.
  const { bridged } = planGapClosures(points);

  const legs: T[][] = [];
  let current: T[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    // A single-point leg is kept rather than dropped: it is a real recorded
    // position, and silently discarding it would under-report where the
    // runner actually was.
    if (!bridged[i]) {
      legs.push(current);
      current = [points[i]];
      continue;
    }
    current.push(points[i]);
  }

  legs.push(current);
  return legs;
}
