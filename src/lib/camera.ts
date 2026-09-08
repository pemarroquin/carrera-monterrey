// Camera-mode geometry behind the Track tab's follow/overview camera model
// (track-map.web.tsx, track-map.tsx). Pure functions, no DOM, no Mapbox, no
// react-native-maps, no React — same testing philosophy as territory.ts and
// tiles.ts: this is the one layer of the camera work that vitest's
// environment: 'node' runner (no React renderer) can actually exercise. See
// this repo's CLAUDE.md.
import { haversineM, type LatLng } from '@/lib/territory';

/** Bounding box of a set of points, plain lat/lng degrees (not a Mapbox
 *  LngLatBoundsLike or a react-native-maps region) — each camera component
 *  converts this into whatever shape its own map API wants. */
export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const EARTH_RADIUS_M = 6371008.8; // mean radius — matches territory.ts's own constant

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Initial great-circle bearing from `a` to `b`, in degrees, 0-360 (0 =
 * north, clockwise) — the standard forward-azimuth formula. Exported on its
 * own (not just folded into bearingFromPath) because destinationPoint below
 * needs the inverse of this, and a direct point-to-point bearing is useful
 * to test in isolation from the "walk back through a path" logic.
 */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Heading source for the follow camera. Walks BACKWARD from the latest point
 * looking for one at least `minSeparationM` away, and derives the bearing
 * from that pair — never from two adjacent fixes, which can be 1-2m apart
 * from GPS jitter alone (a standing runner) and would swing the bearing
 * wildly. Returns null when nothing in the path is far enough from the
 * latest point: standing still, or too early in a run to have moved
 * `minSeparationM` at all. Never invents a heading from noise — the camera
 * component's job is to keep whatever bearing it already had when this
 * returns null, not to snap to something wrong.
 */
export function bearingFromPath(points: LatLng[], minSeparationM: number): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  for (let i = points.length - 2; i >= 0; i--) {
    const candidate = points[i];
    if (haversineM(candidate, latest) >= minSeparationM) {
      return bearingBetween(candidate, latest);
    }
  }
  return null; // every earlier point is within minSeparationM of latest — standing still
}

/**
 * Shortest signed delta (degrees) from `from` to `to`, both expected in
 * 0-360 — e.g. shortestAngleDelta(350, 10) is 20, not -340. This is the
 * shortest-arc helper: without it, interpolating two headings that straddle
 * 0/360 (359° → 1°) would sweep 358° the WRONG way round instead of 2° the
 * right way. Result is always in (-180, 180].
 */
export function shortestAngleDelta(from: number, to: number): number {
  return (((to - from + 180) % 360 + 360) % 360) - 180;
}

/**
 * One smoothing step from `currentBearing` toward `targetBearing`, moving at
 * most `maxStepDeg` along the shortest arc — caps how far a single jittery
 * fix can swing the camera's heading in one update, so a noisy course reads
 * as a smooth turn rather than a snap. Pass `Infinity` for `maxStepDeg` to
 * jump straight to the target (e.g. the very first bearing of a session,
 * where there is no prior heading to smooth from).
 */
export function smoothBearing(currentBearing: number, targetBearing: number, maxStepDeg: number): number {
  const delta = shortestAngleDelta(currentBearing, targetBearing);
  const clamped = Math.max(-maxStepDeg, Math.min(maxStepDeg, delta));
  return (currentBearing + clamped + 360) % 360;
}

/**
 * Destination point `distanceM` from `origin` along initial bearing
 * `bearingDeg` — the standard spherical direct-geodesic formula, using the
 * same Earth radius territory.ts's haversineM uses (so a round trip through
 * bearingBetween + destinationPoint is self-consistent with this file's own
 * distance maths). Used by the native follow camera (track-map.tsx) to push
 * the framed center a little ahead of the runner along their heading, since
 * react-native-maps has no pixel-offset camera option the way Mapbox GL's
 * `offset` does — this is the world-space equivalent of that screen-space
 * trick.
 */
export function destinationPoint(origin: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDeg(lat2), lng: (((toDeg(lng2) + 540) % 360) - 180) }; // normalize lng to [-180, 180)
}

/**
 * Bounding box of every point in the path — the overview camera's fit
 * target ("the whole run so far", track-map.web.tsx / track-map.tsx). Null
 * for an empty path: nothing to fit yet, and the caller should leave the
 * camera wherever it already is rather than fitting to a degenerate box.
 */
export function boundsOfPath(points: LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let west = points[0].lng;
  let east = points[0].lng;
  let south = points[0].lat;
  let north = points[0].lat;
  for (const p of points) {
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return { west, south, east, north };
}

/**
 * The app chrome drawn OVER the map, in pixels. The map fills the whole
 * screen behind it, so the region a runner can actually see is the container
 * minus these.
 *
 * `top` is the live stats block (timer, distance, and the GPS/background
 * warnings under it) plus the safe-area inset it sits below; `bottom` is the
 * floating pill tab bar. They are wildly asymmetric — the stats block is
 * several times the tab bar's height — which is exactly why treating the
 * container as the visible area puts the camera's idea of "centre" well
 * above the eye's.
 */
export interface ChromeInsets {
  top: number;
  bottom: number;
}

/** The band of the map the chrome does NOT cover: its height, and the
 *  distance from the container's own centre to the band's centre (positive
 *  = the band's centre is BELOW the container's). */
export function visibleBand(containerH: number, insets: ChromeInsets): { height: number; centreShiftPx: number } {
  // Degenerate chrome (taller than the container, or a container not laid
  // out yet) would otherwise produce a negative band and invert every
  // calculation below — fall back to the whole container, which is exactly
  // the old behaviour.
  const height = containerH - insets.top - insets.bottom;
  if (!(containerH > 0) || height <= 0) return { height: containerH, centreShiftPx: 0 };
  return { height, centreShiftPx: insets.top + height / 2 - containerH / 2 };
}

/**
 * Screen-space y offset for the follow camera (Mapbox GL's `offset`), so the
 * runner sits `ratio` of the way from the VISIBLE band's centre toward its
 * bottom edge — "more map ahead of you than behind", the turn-by-turn
 * framing, measured against what the runner can actually see.
 *
 * The old form was `containerH * FOLLOW_OFFSET_RATIO` against the raw
 * container. Two things were wrong with it, and only the second is about
 * chrome:
 *
 *  1. An offset of 0.28 from the CENTRE puts the runner at 78% of the
 *     screen — the lower quarter, not the "lower third" its own constant
 *     documented. Reported 2026-09-07 as the route sitting lower than it
 *     should.
 *  2. Measured against the container, the bottom of that range is behind
 *     the tab bar, so the trail immediately behind the runner is occluded
 *     by chrome rather than visible.
 *
 * Returns 0 for a container that has not been laid out yet, which leaves
 * the camera centred rather than throwing the target off-screen.
 */
export function followOffsetPx(containerH: number, insets: ChromeInsets, ratio: number): number {
  if (!(containerH > 0)) return 0;
  const { height, centreShiftPx } = visibleBand(containerH, insets);
  // `ratio` keeps its original meaning — the fraction of a height pushed
  // below a centre — so only the height it is measured against changed.
  return centreShiftPx + height * ratio;
}

/**
 * Padding for the overview fit, so the whole run is framed inside the
 * VISIBLE band instead of the full container — otherwise the top of the
 * route is fitted into the space the timer is drawn over, and the bottom
 * into the tab bar.
 */
export function overviewPadding(
  insets: ChromeInsets,
  basePx: number,
): { top: number; bottom: number; left: number; right: number } {
  return {
    top: insets.top + basePx,
    bottom: insets.bottom + basePx,
    left: basePx,
    right: basePx,
  };
}
