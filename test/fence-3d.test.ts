import { describe, expect, it } from 'vitest';

import { splitTrailing } from '@/lib/fence-3d';
import { haversineM, pathDistanceM, type LatLng } from '@/lib/territory';

/** A straight north-heading track with ~11m between fixes. */
function northLine(count: number): LatLng[] {
  return Array.from({ length: count }, (_, i) => ({ lat: 25.67 + i * 0.0001, lng: -100.31 }));
}

describe('splitTrailing', () => {
  it('leaves everything active until the route is longer than the window', () => {
    const short = northLine(3); // ~22m total, well under a 100m window
    const { settled, active } = splitTrailing(short, 100);
    expect(settled).toEqual([]);
    expect(active).toBe(short);
  });

  it('splits at the requested distance back from the current position', () => {
    const points = northLine(40); // ~433m
    const { settled, active } = splitTrailing(points, 100);
    expect(settled.length).toBeGreaterThan(0);
    // The live edge covers at least the requested window (it splits on the
    // first fix that reaches it, so it can slightly overshoot, never under).
    expect(pathDistanceM(active)).toBeGreaterThanOrEqual(100);
    // ...but isn't wildly longer — one sample's worth of overshoot at most.
    expect(pathDistanceM(active)).toBeLessThan(100 + 15);
  });

  it('shares a join point so the line and the wall meet with no gap', () => {
    const points = northLine(40);
    const { settled, active } = splitTrailing(points, 100);
    expect(settled[settled.length - 1]).toEqual(active[0]);
  });

  it('never loses a point across the split', () => {
    const points = northLine(40);
    const { settled, active } = splitTrailing(points, 100);
    // The join is counted twice by design, hence the +1.
    expect(settled.length + active.length).toBe(points.length + 1);
  });

  it('handles a route too short to split at all', () => {
    expect(splitTrailing([], 100)).toEqual({ settled: [], active: [] });
    const one = [{ lat: 25.67, lng: -100.31 }];
    expect(splitTrailing(one, 100)).toEqual({ settled: [], active: one });
  });
});
