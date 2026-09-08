// The shared gap plausibility policy (src/lib/gap-policy.ts) — imported by
// both tracking.ts's distance credit and tiles.ts's tile gap-fill, so the
// two subsystems can no longer independently decide whether the same real
// gap "happened." This is the layer vitest.config.ts's node environment can
// actually exercise: evaluateGap is pure, no React, no document, no
// visibilitychange event.
//
// One fixture below is built directly from the 2026-09-02 geometry audit's
// numbers (Source Data/Outputs/Running App/Geometry Audit — Saved Runs vs
// Recomputed (2026-09-02).md, run `68e32c11`): a real 76.0s/105.9m gap that
// the audit traced as the entire cause of that run's distance step, and
// which the tile builder was already bridging under the exact same caps
// tested here.
import { describe, expect, it } from 'vitest';

import {
  evaluateGap,
  GAP_CLOSURE_BUDGET_FRACTION,
  MAX_BRIDGE_DISTANCE_M,
  MAX_BRIDGE_SPEED_MS,
  planGapClosures,
  splitLegs,
} from '@/lib/gap-policy';
import { pathToTiles } from '@/lib/tiles';
import type { LatLng } from '@/lib/territory';

// Monterrey-ish latitude, matching territory.test.ts / tiles.test.ts's own
// fixtures.
const LAT = 25.67;
const LNG = -100.31;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

/** A point `metres` due east of a fixed origin. */
function pointEast(metres: number): LatLng {
  return { lat: LAT, lng: LNG + metres / M_PER_DEG_LNG };
}

const ORIGIN = pointEast(0);

describe('evaluateGap', () => {
  it('credits the real audit gap — 76.0s / 105.9m, run 68e32c11', () => {
    const to = pointEast(105.9);
    const dtMs = 76_000;
    const result = evaluateGap({ from: ORIGIN, to, dtMs });
    expect(result).not.toBeNull();
    expect(result!.chordM).toBeCloseTo(105.9, 0);
    // Implied speed ≈ 5.0 km/h, comfortably under both caps.
    expect(result!.credited).toBe(true);
  });

  it('credits a short, ordinary-pace gap', () => {
    const to = pointEast(20);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: 15_000 }); // 4.8 km/h
    expect(result?.credited).toBe(true);
  });

  it('does NOT credit a gap over the distance cap, even at a plausible speed', () => {
    // 200m in 144s is 5 km/h — an entirely ordinary walking pace — but the
    // distance cap exists precisely because plausible speed alone isn't
    // enough: a straight line this long is a guess about which streets were
    // actually taken (see MAX_BRIDGE_DISTANCE_M's own doc).
    const to = pointEast(MAX_BRIDGE_DISTANCE_M + 50);
    const dtMs = ((MAX_BRIDGE_DISTANCE_M + 50) / 1.39) * 1000; // ~5 km/h
    const result = evaluateGap({ from: ORIGIN, to, dtMs });
    expect(result?.chordM).toBeGreaterThan(MAX_BRIDGE_DISTANCE_M);
    expect(result?.credited).toBe(false);
  });

  it('does NOT credit a gap over the speed cap, even under the distance cap', () => {
    // 100m in 2s implies 50 m/s (180 km/h) — a car or a GPS jump, not a
    // runner — well over MAX_BRIDGE_SPEED_MS despite the short distance.
    const to = pointEast(100);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: 2_000 });
    expect(result?.chordM).toBeLessThan(MAX_BRIDGE_DISTANCE_M);
    const impliedSpeedMs = (result?.chordM ?? 0) / 2;
    expect(impliedSpeedMs).toBeGreaterThan(MAX_BRIDGE_SPEED_MS);
    expect(result?.credited).toBe(false);
  });

  it('does NOT credit a zero-duration gap — no elapsed time to judge a speed from', () => {
    const to = pointEast(10);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: 0 });
    expect(result?.credited).toBe(false);
  });

  it('does NOT credit a negative-duration gap (out-of-order timestamps) — fails safe', () => {
    const to = pointEast(10);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: -500 });
    expect(result?.credited).toBe(false);
  });

  it('returns null — nothing to chord against — when there is no prior point', () => {
    // Mirrors tracking.ts: a gap that opens before any fix has ever been
    // recorded (right after Start, before the first fix arrives) has no
    // near end to measure from.
    const result = evaluateGap({ from: null, to: pointEast(10), dtMs: 5_000 });
    expect(result).toBeNull();
  });

  it('a stationary gap (zero chord) is trivially credited — nothing implausible about not moving', () => {
    const result = evaluateGap({ from: ORIGIN, to: ORIGIN, dtMs: 10_000 });
    expect(result?.chordM).toBeCloseTo(0, 3);
    expect(result?.credited).toBe(true);
  });

  it('exposes the same caps tiles.ts bridges gaps with, so both stay in sync', () => {
    expect(MAX_BRIDGE_DISTANCE_M).toBe(150);
    expect(MAX_BRIDGE_SPEED_MS).toBeCloseTo((25 * 1000) / 3600, 6);
  });
});

// ---------------------------------------------------------------------------
// splitLegs — the rendering half of the same policy
// ---------------------------------------------------------------------------
// Regression cover for the bug reported with screenshots on 2026-09-07: an
// iOS Safari run drew a straight chord from the start point to the runner's
// current position across a background gap, because `points` is one flat
// array with no record of its seams.
describe('splitLegs', () => {
  // ~0.001 deg latitude ≈ 111 m — enough to exceed MAX_BRIDGE_DISTANCE_M
  // (150 m) at two steps, while one step stays under it.
  const at = (latOffset: number, ts: number): { lat: number; lng: number; ts: number } => ({
    lat: 25.6866 + latOffset,
    lng: -100.3161,
    ts,
  });

  it('returns no legs at all for an empty path', () => {
    expect(splitLegs([])).toEqual([]);
  });

  it('keeps a clean path as one leg', () => {
    // Three fixes ~11 m apart at a walking pace — every gap credited.
    const points = [at(0, 0), at(0.0001, 10_000), at(0.0002, 20_000)];
    const legs = splitLegs(points);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toHaveLength(3);
  });

  it('breaks the leg on a gap too LONG to know the path taken', () => {
    // ~333 m apart, well over MAX_BRIDGE_DISTANCE_M, at a slow enough pace
    // that the speed cap alone would not catch it — this is the background
    // gap case: physically possible, but we do not know which streets.
    const points = [at(0, 0), at(0.003, 300_000), at(0.0031, 310_000)];
    const legs = splitLegs(points);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toHaveLength(1);
    expect(legs[1]).toHaveLength(2);
  });

  it('breaks the leg on a gap too FAST to be a runner', () => {
    // ~111 m in one second — under the distance cap, far over the speed cap.
    const points = [at(0, 0), at(0.001, 1_000)];
    expect(splitLegs(points)).toHaveLength(2);
  });

  it('never drops a point: every input point appears in exactly one leg', () => {
    const points = [at(0, 0), at(0.003, 300_000), at(0.0031, 310_000), at(0.02, 320_000)];
    const legs = splitLegs(points);
    expect(legs.flat()).toEqual(points);
  });

  it('does not join across the gap — no leg contains both of its endpoints', () => {
    // The actual defect: a renderer drawing legs[0] then legs[1] separately
    // cannot produce the chord, because no single leg holds both sides.
    const before = at(0, 0);
    const after = at(0.02, 300_000);
    const legs = splitLegs([before, after]);
    for (const leg of legs) {
      expect(leg.includes(before) && leg.includes(after)).toBe(false);
    }
  });

  it('agrees with pathToTiles about which gaps are holes', () => {
    // The property that matters beyond this one bug: the drawn route and the
    // claimed tiles must answer "was this gap real" the same way, or the
    // route shows ground the tiles refuse to claim. Both read the same caps.
    const points = [at(0, 0), at(0.0001, 10_000), at(0.02, 300_000), at(0.0201, 310_000)];
    const legs = splitLegs(points);
    const { bridgesSkippedDistance, bridgesSkippedSpeed } = pathToTiles(points);
    expect(legs.length - 1).toBe(bridgesSkippedDistance + bridgesSkippedSpeed);
  });
});

// ---------------------------------------------------------------------------
// planGapClosures — the one decision every consumer reads
// ---------------------------------------------------------------------------
describe('planGapClosures', () => {
  const at = (latOffset: number, ts: number) => ({ lat: 25.6866 + latOffset, lng: -100.3161, ts });

  it('earns a budget from recorded distance and spends it on a long gap', () => {
    // ~3.3 km of ordinary walking earns a ~330m allowance; then a 200m
    // hole at 4.6 km/h — the shape of Pedro's real 2026-09-08 Spotify gap.
    const walk = Array.from({ length: 300 }, (_, i) => at(i * 0.0001, i * 10_000));
    const after = [at(0.0317, 3_145_000), at(0.0318, 3_155_000)];
    const plan = planGapClosures([...walk, ...after]);
    expect(plan.budgetM).toBeCloseTo(plan.recordedM * GAP_CLOSURE_BUDGET_FRACTION, 5);
    expect(plan.usedM).toBeGreaterThan(0);
    expect(plan.skippedBudget).toBe(0);
  });

  it('refuses a gap the run has not earned', () => {
    // Three points: almost no recorded distance, so almost no budget.
    const plan = planGapClosures([at(0, 0), at(0.003, 300_000), at(0.0031, 310_000)]);
    expect(plan.skippedBudget).toBe(1);
    expect(plan.bridged[1]).toBe(false);
  });

  it('spends the budget across the WHOLE run, not per gap', () => {
    // Five identical long gaps cannot each take the full allowance.
    const pts = [at(0, 0)];
    for (let g = 1; g <= 5; g++) {
      pts.push(at(g * 0.004, g * 400_000));
      for (let i = 1; i <= 40; i++) pts.push(at(g * 0.004 + i * 0.0001, g * 400_000 + i * 10_000));
    }
    const plan = planGapClosures(pts);
    expect(plan.usedM).toBeLessThanOrEqual(plan.budgetM);
    expect(plan.skippedBudget).toBeGreaterThan(0);
  });

  it('never bridges an impossible speed, however much budget is left', () => {
    const walk = Array.from({ length: 100 }, (_, i) => at(i * 0.0001, i * 10_000));
    // 222m in one second — a car, or a spoof.
    const plan = planGapClosures([...walk, at(0.0119, 991_000)]);
    expect(plan.skippedSpeed).toBe(1);
    expect(plan.bridged[plan.bridged.length - 1]).toBe(false);
  });

  it('treats a duplicate sample as continuous, not as an impossible speed', () => {
    // 0 m in 0 ms — the tracker recording the same position twice on one
    // millisecond. Measured NINE times on a real 3.2 km walk, every one of
    // them previously counted as "impossible speed" and cutting the route.
    const plan = planGapClosures([at(0, 0), at(0, 0), at(0.0001, 10_000)]);
    expect(plan.skippedSpeed).toBe(0);
    expect(plan.bridged[1]).toBe(true);
  });

  it('still rejects a long jump when the clock is broken', () => {
    // No usable dt AND far — the fallback must not become a way through.
    const plan = planGapClosures([at(0, 0), at(0.01, 0)]);
    expect(plan.bridged[1]).toBe(false);
  });
});
