// Pure logic behind the Track tab's follow/overview camera model
// (track-map.web.tsx, track-map.tsx). Split out from those components
// precisely so this can be tested at all — vitest here is environment:
// 'node' with no React renderer (see vitest.config.ts's own header), so
// nothing inside a component or hook effect is covered; this file is.
//
// Two cases the camera brief calls out explicitly: a bearing crossing
// 0/360 must interpolate the SHORT way (not spin the long way round), and
// a standing-still input must return null (never invent a heading from GPS
// jitter between two nearly-identical fixes).
import { describe, expect, it } from 'vitest';

import {
  bearingBetween,
  bearingFromPath,
  boundsOfPath,
  destinationPoint,
  followOffsetPx,
  overviewPadding,
  shortestAngleDelta,
  smoothBearing,
  visibleBand,
} from '@/lib/camera';
import { FOLLOW_OFFSET_RATIO } from '@/constants/map';
import { haversineM, type LatLng } from '@/lib/territory';

// Monterrey-ish latitude, matching territory.test.ts / tiles.test.ts's own
// fixtures.
const LAT = 25.67;
const LNG = -100.31;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

/** A point `metres` in a cardinal direction from a fixed origin. */
function pointNorth(metres: number): LatLng {
  return { lat: LAT + metres / M_PER_DEG_LAT, lng: LNG };
}
function pointEast(metres: number): LatLng {
  return { lat: LAT, lng: LNG + metres / M_PER_DEG_LNG };
}
function pointSouth(metres: number): LatLng {
  return { lat: LAT - metres / M_PER_DEG_LAT, lng: LNG };
}
function pointWest(metres: number): LatLng {
  return { lat: LAT, lng: LNG - metres / M_PER_DEG_LNG };
}

const ORIGIN: LatLng = { lat: LAT, lng: LNG };

describe('bearingBetween', () => {
  it('reads north as 0°', () => {
    expect(bearingBetween(ORIGIN, pointNorth(50))).toBeCloseTo(0, 0);
  });
  it('reads east as 90°', () => {
    expect(bearingBetween(ORIGIN, pointEast(50))).toBeCloseTo(90, 0);
  });
  it('reads south as 180°', () => {
    expect(bearingBetween(ORIGIN, pointSouth(50))).toBeCloseTo(180, 0);
  });
  it('reads west as 270°', () => {
    expect(bearingBetween(ORIGIN, pointWest(50))).toBeCloseTo(270, 0);
  });
});

describe('bearingFromPath', () => {
  const MIN_SEP_M = 8;

  it('returns null for a standing-still path — never invents a heading from GPS jitter', () => {
    // Every point within a metre or two of the last one, well under
    // MIN_SEP_M — the exact "standing still, noisy fixes" case the brief
    // calls out.
    const points: LatLng[] = [
      pointNorth(0),
      pointNorth(0.5),
      pointNorth(1.1),
      pointNorth(0.8),
      pointNorth(1.4),
    ];
    expect(bearingFromPath(points, MIN_SEP_M)).toBeNull();
  });

  it('returns null for fewer than two points', () => {
    expect(bearingFromPath([], MIN_SEP_M)).toBeNull();
    expect(bearingFromPath([ORIGIN], MIN_SEP_M)).toBeNull();
  });

  it('derives a heading once an earlier point clears minSeparationM', () => {
    // Running due east, 3m per fix — no single consecutive pair clears 8m,
    // but walking back further does.
    const points = [pointEast(0), pointEast(3), pointEast(6), pointEast(9), pointEast(12)];
    const bearing = bearingFromPath(points, MIN_SEP_M);
    expect(bearing).not.toBeNull();
    expect(bearing as number).toBeCloseTo(90, 0);
  });

  it('skips a trailing cluster of jittery fixes to find real motion further back', () => {
    // Moved 40m north, then stood still for a few noisy fixes at the end.
    const points = [pointNorth(0), pointNorth(40), pointNorth(40.6), pointNorth(39.9), pointNorth(40.3)];
    const bearing = bearingFromPath(points, MIN_SEP_M);
    expect(bearing).not.toBeNull();
    expect(bearing as number).toBeCloseTo(0, 0);
  });
});

describe('shortestAngleDelta', () => {
  it('is the short way across the 0/360 seam, not the long way', () => {
    // 350° -> 10° is +20 the short way; the naive (to - from) is -340.
    expect(shortestAngleDelta(350, 10)).toBeCloseTo(20, 5);
    expect(shortestAngleDelta(10, 350)).toBeCloseTo(-20, 5);
  });

  it('handles a plain delta with no wraparound', () => {
    expect(shortestAngleDelta(30, 80)).toBeCloseTo(50, 5);
    expect(shortestAngleDelta(80, 30)).toBeCloseTo(-50, 5);
  });

  it('returns 0 for identical headings', () => {
    expect(shortestAngleDelta(123, 123)).toBeCloseTo(0, 5);
  });

  it('resolves an exact 180° apart consistently', () => {
    expect(Math.abs(shortestAngleDelta(0, 180))).toBeCloseTo(180, 5);
  });
});

describe('smoothBearing', () => {
  it('crosses the 0/360 seam the short way, not the long way round', () => {
    // From 350° toward 10°: the short arc is +20 through 360/0. A step cap
    // of 5° should move to 355°, NOT swing backward toward 180°.
    const next = smoothBearing(350, 10, 5);
    expect(next).toBeCloseTo(355, 5);
  });

  it('caps a large jump to maxStepDeg', () => {
    const next = smoothBearing(0, 90, 10);
    expect(next).toBeCloseTo(10, 5);
  });

  it('jumps straight to the target when maxStepDeg is Infinity', () => {
    expect(smoothBearing(0, 271, Infinity)).toBeCloseTo(271, 5);
    expect(smoothBearing(350, 10, Infinity)).toBeCloseTo(10, 5);
  });

  it('does not overshoot when already within maxStepDeg of the target', () => {
    expect(smoothBearing(88, 90, 10)).toBeCloseTo(90, 5);
  });

  it('always returns a value in [0, 360)', () => {
    for (let from = 0; from < 360; from += 37) {
      for (let to = 0; to < 360; to += 53) {
        const result = smoothBearing(from, to, 15);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(360);
      }
    }
  });
});

describe('destinationPoint', () => {
  it('round-trips with bearingBetween — the bearing back to origin matches what was travelled', () => {
    const dest = destinationPoint(ORIGIN, 90, 100); // 100m due east
    expect(bearingBetween(ORIGIN, dest)).toBeCloseTo(90, 0);
    expect(haversineM(ORIGIN, dest)).toBeCloseTo(100, -1); // within ~10m at this scale
  });

  it('moving 0m returns (approximately) the same point', () => {
    const dest = destinationPoint(ORIGIN, 45, 0);
    expect(haversineM(ORIGIN, dest)).toBeCloseTo(0, 1);
  });

  it('normalizes longitude when crossing the antimeridian', () => {
    const nearDateline: LatLng = { lat: 0, lng: 179.9999 };
    const dest = destinationPoint(nearDateline, 90, 50_000); // 50km east, over the seam
    expect(dest.lng).toBeGreaterThanOrEqual(-180);
    expect(dest.lng).toBeLessThan(180);
  });
});

describe('boundsOfPath', () => {
  it('returns null for an empty path', () => {
    expect(boundsOfPath([])).toBeNull();
  });

  it('collapses to a point for a single-point path', () => {
    expect(boundsOfPath([ORIGIN])).toEqual({ west: LNG, east: LNG, south: LAT, north: LAT });
  });

  it('encloses every point of a path in every direction', () => {
    const points = [pointNorth(80), pointSouth(30), pointEast(60), pointWest(20), ORIGIN];
    const bounds = boundsOfPath(points);
    expect(bounds).not.toBeNull();
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual((bounds as NonNullable<typeof bounds>).south);
      expect(p.lat).toBeLessThanOrEqual((bounds as NonNullable<typeof bounds>).north);
      expect(p.lng).toBeGreaterThanOrEqual((bounds as NonNullable<typeof bounds>).west);
      expect(p.lng).toBeLessThanOrEqual((bounds as NonNullable<typeof bounds>).east);
    }
  });
});

// ---------------------------------------------------------------------------
// Chrome-aware framing
// ---------------------------------------------------------------------------
// Reported 2026-09-07: the route sat lower on screen than it should. Two
// separate causes, both encoded here so neither can come back.
describe('visibleBand', () => {
  it('subtracts the chrome and reports how far the visible centre sits below the container centre', () => {
    // A container 1000 tall with 300 of stats on top and 100 of tab bar
    // below leaves a 600 band whose centre is at 300 + 300 = 600, i.e. 100
    // below the container's own centre of 500.
    expect(visibleBand(1000, { top: 300, bottom: 100 })).toEqual({ height: 600, centreShiftPx: 100 });
  });

  it('is a no-op when nothing covers the map', () => {
    expect(visibleBand(1000, { top: 0, bottom: 0 })).toEqual({ height: 1000, centreShiftPx: 0 });
  });

  it('falls back to the whole container rather than inverting on degenerate chrome', () => {
    // Chrome taller than the container (a not-yet-laid-out container, or a
    // very small window) would otherwise give a negative height and flip
    // every offset derived from it.
    expect(visibleBand(200, { top: 300, bottom: 100 })).toEqual({ height: 200, centreShiftPx: 0 });
    expect(visibleBand(0, { top: 0, bottom: 0 })).toEqual({ height: 0, centreShiftPx: 0 });
  });
});

describe('followOffsetPx', () => {
  it('puts the runner two thirds down the VISIBLE band at the shipped ratio', () => {
    const containerH = 1000;
    const insets = { top: 300, bottom: 100 };
    const offset = followOffsetPx(containerH, insets, FOLLOW_OFFSET_RATIO);
    // Where the runner actually lands, in container coordinates.
    const y = containerH / 2 + offset;
    const { height } = visibleBand(containerH, insets);
    const fractionOfBand = (y - insets.top) / height;
    // "Lower third" — the framing FOLLOW_OFFSET_RATIO's doc has always
    // claimed. The old 0.28-of-the-container form put this at 0.78.
    expect(fractionOfBand).toBeCloseTo(2 / 3, 2);
  });

  it('centres in the visible band at ratio 0 — the documented way to opt out', () => {
    const offset = followOffsetPx(1000, { top: 300, bottom: 100 }, 0);
    expect(1000 / 2 + offset).toBe(600); // the band's centre
  });

  it('is 0 before the container has been laid out', () => {
    expect(followOffsetPx(0, { top: 300, bottom: 100 }, FOLLOW_OFFSET_RATIO)).toBe(0);
  });
});

describe('overviewPadding', () => {
  it('adds the chrome to the base padding so the fit lands in the visible band', () => {
    expect(overviewPadding({ top: 300, bottom: 100 }, 56)).toEqual({
      top: 356,
      bottom: 156,
      left: 56,
      right: 56,
    });
  });

  it('degrades to uniform padding when nothing covers the map', () => {
    expect(overviewPadding({ top: 0, bottom: 0 }, 56)).toEqual({
      top: 56,
      bottom: 56,
      left: 56,
      right: 56,
    });
  });
});
