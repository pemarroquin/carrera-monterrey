// Native GPS access — a thin wrapper over expo-location, preserving exactly
// today's behaviour (Accuracy.BestForNavigation, the same timeInterval /
// distanceInterval, getLastKnownPositionAsync, getCurrentPositionAsync,
// requestForegroundPermissionsAsync). No behaviour change on native.
//
// This file exists opposite geolocation.web.ts: Metro resolves the `.web.ts`
// suffix automatically on web and falls back to this file everywhere else,
// same convention as db.ts / db.web.ts and track-map.tsx / track-map.web.tsx.
// Callers (tracking.ts, use-current-location.ts) import from '@/lib/geolocation'
// with no suffix and never branch on Platform.OS themselves.
//
// Why a shared module exists at all: expo-location's WEB shim
// (ExpoLocation.web.js) has three defects, all in the watch path — a watch-id
// mismatch that lets a stale browser callback tear down a live watch,
// enableHighAccuracy/timeout never mapped onto navigator.geolocation.watchPosition,
// and an undefined error callback that swallows PERMISSION_DENIED /
// POSITION_UNAVAILABLE / TIMEOUT entirely. See geolocation.web.ts for the fix.
// Native is unaffected — expo-location's native module has none of these bugs
// — so this file just forwards to it unchanged.
import * as Location from 'expo-location';

export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  ts: number; // epoch ms
}
export interface GeoWatchOptions {
  timeIntervalMs: number;
  distanceIntervalM: number;
  /** BestForNavigation for the run tracker; Balanced for a watch that only
   *  has to keep a map pin honest (use-current-location.ts's idle Track tab
   *  pin — that doesn't need, and shouldn't pay for, navigation-grade GPS
   *  power draw). Restores the pre-P0 native behaviour. */
  highAccuracy: boolean;
}
export interface GeoWatch {
  remove(): void;
}
export type GeoPermission = 'granted' | 'denied' | 'unavailable';
export type GeoErrorKind = 'permission' | 'unavailable' | 'timeout';

function toFix(pos: Location.LocationObject): GeoFix {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? null,
    ts: pos.timestamp,
  };
}

export async function requestPermission(): Promise<GeoPermission> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

export async function getLastKnown(maxAgeMs: number): Promise<GeoFix | null> {
  try {
    const pos = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    return pos ? toFix(pos) : null;
  } catch {
    return null;
  }
}

export async function getCurrent(): Promise<GeoFix | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.BestForNavigation,
    });
    return toFix(pos);
  } catch {
    return null;
  }
}

export async function watch(
  opts: GeoWatchOptions,
  onFix: (fix: GeoFix) => void,
  onError: (kind: GeoErrorKind) => void,
): Promise<GeoWatch> {
  try {
    const sub = await Location.watchPositionAsync(
      {
        accuracy: opts.highAccuracy ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced,
        timeInterval: opts.timeIntervalMs,
        distanceInterval: opts.distanceIntervalM,
      },
      (pos) => onFix(toFix(pos)),
    );
    return { remove: () => sub.remove() };
  } catch {
    // expo-location's native watchPositionAsync rejects when permission was
    // never granted (callers already gate on requestPermission(), so this is
    // a defensive fallback, not the primary permission path).
    onError('permission');
    return { remove: () => {} };
  }
}

/**
 * The native half of geolocation.web.ts's permission-state read — see that
 * file for what the four states mean and why the web needed them.
 *
 * Native maps cleanly onto expo-location's own answer, which (unlike its web
 * shim) reports `canAskAgain` truthfully: false means the OS has settled the
 * question and only the settings app can reopen it.
 */
export type GeoPermissionState = 'granted' | 'askable' | 'blocked' | 'unknown';

export async function getPermissionState(): Promise<GeoPermissionState> {
  try {
    const res = await Location.getForegroundPermissionsAsync();
    if (res.granted) return 'granted';
    return res.canAskAgain ? 'askable' : 'blocked';
  } catch {
    // No provider on this device — the same 'unknown' the web returns when
    // navigator.geolocation is missing, rather than a claim of "denied".
    return 'unknown';
  }
}

/**
 * No-op on native: there is no OS callback for "the runner changed this in
 * the settings app". The screen re-reads on focus instead, which is the
 * moment they come back from it — see location.tsx's effect.
 */
export function onPermissionStateChange(_listener: (state: GeoPermissionState) => void): () => void {
  return () => {};
}
