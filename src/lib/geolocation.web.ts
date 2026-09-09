// Web GPS access — talks to navigator.geolocation directly instead of going
// through expo-location's web shim. Metro picks this file automatically on
// web; native uses geolocation.ts instead. Same convention as db.ts /
// db.web.ts and track-map.tsx / track-map.web.tsx.
//
// Why this file exists: `expo-location`'s web shim
// (node_modules/expo-location/build/ExpoLocation.web.js) has three defects,
// all in the watch path, diagnosed against a real 60s screen recording where
// the map never moved for a full minute (Web-First Pilot P0 brief, §1-§2):
//
// (a) Watch-id mismatch — the shim emits under the BROWSER's watchPosition
//     id, but LocationSubscribers.js registers callbacks under Expo's own
//     counter. When the idle watcher's freed browser id gets recycled by a
//     later watch, every emit arrives keyed wrong, finds no callback, and
//     the subscriber's `else` branch calls removeWatchAsync() on that id —
//     which can tear down a DIFFERENT, live watch (ours). One seed fix
//     lands, then permanent silence.
// (b) `enableHighAccuracy` (and timeout/maximumAge) are never mapped for
//     watches — the shim forwards `{ accuracy, timeInterval,
//     distanceInterval }` raw into watchPosition, which the browser doesn't
//     understand, so they're silently discarded.
// (c) The error callback passed to watchPosition is `undefined`, so
//     PERMISSION_DENIED / POSITION_UNAVAILABLE / TIMEOUT are swallowed —  a
//     dead watch looks identical to a working one.
//
// The fix for all three is the same: own the browser watch id directly,
// never round-trip through the shim's registry.
import { haversineM } from '@/lib/territory';

export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  ts: number; // epoch ms
}
export interface GeoWatchOptions {
  timeIntervalMs: number;
  distanceIntervalM: number;
  /** Balanced accuracy for a watch that only has to keep a map pin honest
   *  (use-current-location.ts); high accuracy for the run tracker, which
   *  needs BestForNavigation-grade fixes. See tracking.ts / use-current-location.ts
   *  callers. */
  highAccuracy: boolean;
}
export interface GeoWatch {
  remove(): void;
}
export type GeoPermission = 'granted' | 'denied' | 'unavailable';
export type GeoErrorKind = 'permission' | 'unavailable' | 'timeout';

// Options for the one-shot calls and (with enableHighAccuracy overridden per
// GeoWatchOptions.highAccuracy) the watch. maximumAge: 0 so a stale OS-cached
// fix never masquerades as fresh — staleness is handled explicitly by
// getLastKnown() below instead.
const POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 30_000,
};

// The permission probe (requestPermission()'s fallback below) only needs to
// answer "is this origin allowed to see location", not "where is the
// device" — so it asks cheaply. Using POSITION_OPTIONS here (high accuracy,
// 30s timeout) meant a cold high-accuracy fix in an urban canyon could blow
// past 30s, and start() in tracking.ts awaits this probe, so Start refused
// to begin on a phone with perfectly good GPS (Web-First Pilot P0.1, bug 1).
const PERMISSION_PROBE_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: Infinity,
  timeout: 10_000,
};

function toFix(position: GeolocationPosition): GeoFix {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyM: position.coords.accuracy ?? null,
    ts: position.timestamp,
  };
}

function mapError(err: GeolocationPositionError): GeoErrorKind {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'permission';
    case err.TIMEOUT:
      return 'timeout';
    case err.POSITION_UNAVAILABLE:
    default:
      return 'unavailable';
  }
}

// Updated by EVERY successful fix, from the watch path or either one-shot
// call. This matters because bypassing the shim means the shim's own
// `lastKnownPosition` cache is never written — without this,
// getLastKnown() would return null forever and a run would lose its instant
// origin (the cached-position seed in tracking.ts's beginRecording()).
let lastKnown: GeoFix | null = null;

export async function requestPermission(): Promise<GeoPermission> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unavailable';

  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'granted') return 'granted';
      if (status.state === 'denied') return 'denied';
      // 'prompt' falls through to the probe below, which is what actually
      // triggers the browser's permission dialog.
    } catch {
      // Permissions API present but this query unsupported (older Safari) —
      // fall through to the probe.
    }
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        lastKnown = toFix(position);
        resolve('granted');
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          resolve('denied');
          return;
        }
        // A TIMEOUT here means the user allowed access and the receiver is
        // merely slow to produce a fix — a different code (PERMISSION_DENIED)
        // covers an actual denial. Treating a slow probe as a denial refused
        // Start on a phone with perfectly good GPS; the real watch (with its
        // own, longer timeout) is what actually recovers.
        resolve(err.code === err.TIMEOUT ? 'granted' : 'unavailable');
      },
      PERMISSION_PROBE_OPTIONS,
    );
  });
}

export async function getLastKnown(maxAgeMs: number): Promise<GeoFix | null> {
  if (!lastKnown) return null;
  if (Date.now() - lastKnown.ts > maxAgeMs) return null;
  return lastKnown;
}

export async function getCurrent(): Promise<GeoFix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix = toFix(position);
        lastKnown = fix;
        resolve(fix);
      },
      () => resolve(null),
      POSITION_OPTIONS,
    );
  });
}

export async function watch(
  opts: GeoWatchOptions,
  onFix: (fix: GeoFix) => void,
  onError: (kind: GeoErrorKind) => void,
): Promise<GeoWatch> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    onError('unavailable');
    return { remove: () => {} };
  }

  // Own the numeric id directly — never the shim's registry (defect a).
  let removed = false;
  // The last fix actually EMITTED (post-throttle), used to decide whether
  // the next raw callback should be let through. Distinct from `lastKnown`,
  // which is updated on every raw fix regardless of throttling.
  let lastEmitted: GeoFix | null = null;

  const id = navigator.geolocation.watchPosition(
    (position) => {
      if (removed) return; // late callback after remove() — ignore (defect a)
      const fix = toFix(position);
      lastKnown = fix;

      // Throttling the browser doesn't do natively (defect b: the shim
      // forwarded timeInterval/distanceInterval, which the browser ignores).
      // The first fix of a watch always emits — a cold receiver's first
      // reading is often the only thing available for a while.
      if (lastEmitted) {
        const elapsedMs = fix.ts - lastEmitted.ts;
        const movedM = haversineM(lastEmitted, fix);
        if (elapsedMs < opts.timeIntervalMs && movedM < opts.distanceIntervalM) {
          return;
        }
      }
      lastEmitted = fix;
      onFix(fix);
    },
    (err) => {
      if (removed) return;
      onError(mapError(err)); // defect c: the shim never wired this at all
    },
    // defect b: enableHighAccuracy now actually reaches the browser.
    // enableHighAccuracy itself comes from the caller (tracking.ts wants
    // BestForNavigation-grade fixes; use-current-location.ts's idle pin
    // doesn't and shouldn't pay that battery cost — P0.1 bug 3).
    { ...POSITION_OPTIONS, enableHighAccuracy: opts.highAccuracy },
  );

  return {
    remove: () => {
      removed = true;
      navigator.geolocation.clearWatch(id);
    },
  };
}

/**
 * What the settings screen needs to know: can the permission prompt still be
 * shown, or is the only way through the browser's own UI?
 *
 * `GeoPermission` above cannot answer that — it collapses "the runner
 * dismissed the prompt" and "the runner pressed Block" into 'denied', and
 * they need opposite things from the interface. One is a button. The other
 * is instructions, because no amount of calling getCurrentPosition will
 * re-open a prompt the browser has decided against.
 *
 *  granted  — has it.
 *  askable  — a call to requestPermission() will show the browser's prompt.
 *  blocked  — it will NOT. Only the site settings can undo this.
 *  unknown  — no geolocation provider at all.
 *
 * Read-only ON PURPOSE: it must never call getCurrentPosition, because that
 * IS the prompt. A screen that probed to render its own status would raise
 * the dialog every time it was opened.
 */
export type GeoPermissionState = 'granted' | 'askable' | 'blocked' | 'unknown';

export async function getPermissionState(): Promise<GeoPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unknown';
  if (!navigator.permissions?.query) {
    // No Permissions API: geolocation still works, we simply cannot read its
    // state without prompting. 'askable' is the honest answer — trying is
    // exactly what is available — and the prompt is a no-op if it is already
    // granted.
    return 'askable';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'blocked' : 'askable';
  } catch {
    // Permissions API present but this query unsupported (older Safari).
    return 'askable';
  }
}

/**
 * Fires when the browser's geolocation permission changes — including from
 * the browser's OWN site-settings UI, which is the only place a blocked
 * permission can be undone.
 *
 * That is the whole reason this exists. Unblocking happens outside the page,
 * so without it the screen would keep saying "Blocked" after the runner has
 * just fixed it, and the instructions telling them to fix it would appear to
 * have failed. The `change` event is on the PermissionStatus object itself,
 * so it needs the query kept alive rather than re-run.
 *
 * Returns an unsubscribe. Never throws: on a browser without the Permissions
 * API there is nothing to listen to, and the screen's own re-read on focus
 * remains the fallback.
 */
export function onPermissionStateChange(listener: (state: GeoPermissionState) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return () => {};
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const handle = () => {
    if (!status || cancelled) return;
    listener(status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'blocked' : 'askable');
  };
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((result) => {
      if (cancelled) return;
      status = result;
      result.addEventListener('change', handle);
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    status?.removeEventListener('change', handle);
  };
}
