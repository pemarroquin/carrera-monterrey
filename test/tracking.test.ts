// The GPS accuracy filter's accept/reject rule.
//
// These exist because of a real device bug (2026-08-27): near an office
// building every fix reported >100m accuracy, the filter rejected all of
// them, and the route never grew past its single seed point — so no line was
// ever drawn. Pausing and resuming was the only thing that worked, because
// resume() clears `lastRef` and the first fix of a leg bypasses the filter.
//
// The rule that fixes it: reject OUTLIERS, never the environment.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GeoFix } from '../src/lib/geolocation.web';
import {
  getPermissionState,
  onPermissionStateChange,
  requestPermission,
  watch,
} from '../src/lib/geolocation.web';
import { shouldAcceptFix } from '../src/lib/tracking';

describe('shouldAcceptFix', () => {
  it('always keeps the first fix of a leg, however poor', () => {
    expect(
      shouldAcceptFix({ isFirst: true, accuracyM: 5000, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('keeps an accurate fix', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 12, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('drops an isolated poor fix — outlier rejection still works', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 400, consecutiveRejects: 0 }),
    ).toBe(false);
  });

  it('FAILS OPEN once poor fixes are sustained — the office-building bug', () => {
    // Three in a row means this is the environment, not an outlier. A
    // degraded route beats no route at all.
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 400, consecutiveRejects: 3 }),
    ).toBe(true);
  });

  it('never starves the track no matter how long the signal stays poor', () => {
    // The actual regression: with an unconditional filter, every one of
    // these was dropped and the route stayed a single point forever.
    let consecutiveRejects = 0;
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      if (shouldAcceptFix({ isFirst: false, accuracyM: 250, consecutiveRejects })) {
        accepted++;
        consecutiveRejects = 0;
      } else {
        consecutiveRejects++;
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it('keeps a fix that reports no accuracy at all', () => {
    // Nothing to judge on — dropping these would discard usable positions on
    // any platform that omits the field.
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: null, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('honours the boundary exactly', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 100, consecutiveRejects: 0, maxAccuracyM: 100 }),
    ).toBe(true);
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 101, consecutiveRejects: 0, maxAccuracyM: 100 }),
    ).toBe(false);
  });
});

// geolocation.web.ts's watch() — the fix for the three expo-location web-shim
// defects (Web-First Pilot P0 brief, §2). These test the file directly by
// its `.web` suffix rather than through the '@/lib/geolocation' alias tsc
// resolves to geolocation.ts by default outside Metro; the point of these
// tests is the browser-specific throttle/remove/error-mapping logic that
// only geolocation.web.ts contains.
//
// A minimal stand-in for the browser's Geolocation API. Deliberately does
// NOT gate `trigger()` on a prior clearWatch() call — a real browser can
// still deliver an already-queued callback after clearWatch() runs, which is
// exactly the "late callback" scenario defect (a) needs guarding against.
// That guard has to live in geolocation.web.ts itself (the `removed` flag),
// not in this fake.
class FakeGeolocation {
  // Keyed by id so multiple concurrent watch() calls stay independent — see
  // the P1 concurrency test below. Each registration keeps its OWN callbacks
  // rather than sharing one slot, which is what lets a "late callback after
  // remove()" test on one watch coexist with an untouched second watch.
  private watchers = new Map<
    number,
    { success: PositionCallback; error: PositionErrorCallback | null }
  >();
  private nextId = 0;
  private currentSuccess: PositionCallback | null = null;
  private currentError: PositionErrorCallback | null = null;
  lastWatchId = 0;
  /** Every id clearWatch() was called with, for asserting the RIGHT watch —
   *  and only that one — was torn down. */
  clearedIds: number[] = [];
  /** Options watchPosition()/getCurrentPosition() were last called with —
   *  lets a test assert what actually reaches the browser (e.g.
   *  enableHighAccuracy). */
  lastWatchOptions: PositionOptions | undefined;
  lastGetCurrentOptions: PositionOptions | undefined;

  watchPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number {
    this.nextId += 1;
    this.watchers.set(this.nextId, { success, error: error ?? null });
    this.lastWatchId = this.nextId;
    this.lastWatchOptions = options;
    return this.nextId;
  }

  clearWatch(id: number): void {
    // Tracked but deliberately does NOT remove the handler — see the class
    // comment: a real browser can still deliver an already-queued callback
    // after clearWatch() runs, and that "late callback" case is exactly what
    // geolocation.web.ts's own `removed` flag has to guard against, not this
    // fake.
    this.clearedIds.push(id);
  }

  getCurrentPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): void {
    this.currentSuccess = success;
    this.currentError = error ?? null;
    this.lastGetCurrentOptions = options;
  }

  /** Defaults to the most recently registered watch, matching every
   *  single-watch test below; pass an id explicitly to target a specific
   *  one when more than one is live. */
  trigger(position: GeolocationPosition, id: number = this.lastWatchId): void {
    this.watchers.get(id)?.success(position);
  }

  triggerError(err: GeolocationPositionError, id: number = this.lastWatchId): void {
    this.watchers.get(id)?.error?.(err);
  }

  triggerCurrent(position: GeolocationPosition): void {
    this.currentSuccess?.(position);
  }

  triggerCurrentError(err: GeolocationPositionError): void {
    this.currentError?.(err);
  }
}

function makePosition(lat: number, lng: number, ts: number, accuracy: number | null = 10): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: ts,
    toJSON: () => ({}),
  } as GeolocationPosition;
}

function makeError(code: number): GeolocationPositionError {
  return {
    code,
    message: '',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('geolocation.web watch()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops a fix that is both too soon and too close, but lets either threshold alone through', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixes: GeoFix[] = [];

    await watch({ timeIntervalMs: 2000, distanceIntervalM: 5, highAccuracy: true }, (f) => fixes.push(f), () => {});

    fakeGeo.trigger(makePosition(19.4, -99.1, 0)); // first fix — always emits
    fakeGeo.trigger(makePosition(19.4, -99.1, 1000)); // 1s, 0m — both fail, dropped
    fakeGeo.trigger(makePosition(19.4, -99.1, 3000)); // 3s, 0m — time alone passes
    fakeGeo.trigger(makePosition(19.4001, -99.1, 3500)); // 0.5s, ~11m — distance alone passes

    expect(fixes).toHaveLength(3);
  });

  it('always emits the first fix of a watch, however soon or close', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixes: GeoFix[] = [];

    await watch({ timeIntervalMs: 999_999, distanceIntervalM: 999_999, highAccuracy: true }, (f) => fixes.push(f), () => {});
    fakeGeo.trigger(makePosition(19.4, -99.1, 0));

    expect(fixes).toHaveLength(1);
  });

  it('ignores a late callback after remove() — the watch-id-recycling bug', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixes: GeoFix[] = [];

    const sub = await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true }, (f) => fixes.push(f), () => {});
    sub.remove();
    fakeGeo.trigger(makePosition(19.4, -99.1, 0));

    expect(fixes).toHaveLength(0);
  });

  it.each([
    [1, 'permission'],
    [2, 'unavailable'],
    [3, 'timeout'],
  ])('maps browser error code %d to %s', async (code, expectedKind) => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const kinds: string[] = [];

    await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true }, () => {}, (kind) => kinds.push(kind));
    fakeGeo.triggerError(makeError(code));

    expect(kinds).toEqual([expectedKind]);
  });

  it("forwards GeoWatchOptions.highAccuracy as the browser's enableHighAccuracy", async () => {
    const fakeGeoOff = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeoOff });
    await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: false }, () => {}, () => {});
    expect(fakeGeoOff.lastWatchOptions?.enableHighAccuracy).toBe(false);

    const fakeGeoOn = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeoOn });
    await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true }, () => {}, () => {});
    expect(fakeGeoOn.lastWatchOptions?.enableHighAccuracy).toBe(true);
  });

  // P1 concurrency bug (tracking.ts's beginRecording(), fixed with an epoch
  // guard): visibilitychange can fire more than once in quick succession, and
  // with no guard the SECOND beginRecording() call's watch overwrites
  // subRef.current before the FIRST's async watchPosition() resolves — so
  // the first watch installs itself with nothing left pointing to it, and
  // keeps feeding onFix for the rest of the run (duplicated points, inflated
  // distance/area). The fix lives in tracking.ts, which this project's
  // vitest setup can't unit-test (no React renderer — see
  // vitest.config.ts's header). What CAN be tested here is the foundation
  // that fix depends on: that two concurrent watch() calls stay fully
  // independent, so abandoning one via remove() never touches the other.
  it('keeps two concurrent watches independent — the foundation the epoch guard relies on', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixesA: GeoFix[] = [];
    const fixesB: GeoFix[] = [];

    const subA = await watch(
      { timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true },
      (f) => fixesA.push(f),
      () => {},
    );
    const idA = fakeGeo.lastWatchId;
    const subB = await watch(
      { timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true },
      (f) => fixesB.push(f),
      () => {},
    );
    const idB = fakeGeo.lastWatchId;
    expect(idA).not.toBe(idB);

    // Abandon A — exactly what the epoch guard does to a beginRecording()
    // call superseded by a later one.
    subA.remove();
    expect(fakeGeo.clearedIds).toEqual([idA]);

    fakeGeo.trigger(makePosition(19.4, -99.1, 0), idA);
    fakeGeo.trigger(makePosition(19.5, -99.2, 0), idB);

    expect(fixesA).toHaveLength(0); // removed — a late callback is ignored
    expect(fixesB).toHaveLength(1); // the surviving watch is untouched
  });
});

// requestPermission()'s fallback probe (navigator.permissions unavailable, or
// its query resolved 'prompt'). P0.1 bug 1: the probe used to reuse the
// high-accuracy, 30s-timeout POSITION_OPTIONS meant for the real watch — a
// cold high-accuracy fix in an urban canyon can exceed 30s, and start() in
// tracking.ts awaits this probe, so a TIMEOUT there hard-failed Start on a
// phone with perfectly good GPS. A TIMEOUT means the user allowed access and
// the receiver is merely slow (PERMISSION_DENIED is the separate code for an
// actual denial) — the watcher, with its own longer timeout, is what
// actually recovers.
describe('geolocation.web requestPermission() probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves granted on a probe TIMEOUT, not unavailable', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });

    const resultPromise = requestPermission();
    fakeGeo.triggerCurrentError(makeError(3)); // TIMEOUT

    expect(await resultPromise).toBe('granted');
  });

  it('still resolves denied on PERMISSION_DENIED', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });

    const resultPromise = requestPermission();
    fakeGeo.triggerCurrentError(makeError(1)); // PERMISSION_DENIED

    expect(await resultPromise).toBe('denied');
  });
});

// getPermissionState() — the read the Location settings screen renders from,
// and the reason it exists: expo-location's web shim reports
// `canAskAgain: true` in EVERY branch, including denied. The screen believed
// it, offered "Enable location", and the request path then returned DENIED
// without ever calling getCurrentPosition. No prompt, no error, nothing on
// screen. These pin the distinction the shim collapses.
describe('getPermissionState', () => {
  const query = (state: string) => vi.fn().mockResolvedValue({ state });

  it('reports granted', async () => {
    vi.stubGlobal('navigator', { geolocation: {}, permissions: { query: query('granted') } });
    expect(await getPermissionState()).toBe('granted');
  });

  it('reports a DISMISSED prompt as askable — the case the button is for', async () => {
    vi.stubGlobal('navigator', { geolocation: {}, permissions: { query: query('prompt') } });
    expect(await getPermissionState()).toBe('askable');
  });

  it('reports an explicit block as blocked, NOT as askable', async () => {
    // The exact lie the shim told. Getting this wrong puts a button on
    // screen that cannot do anything.
    vi.stubGlobal('navigator', { geolocation: {}, permissions: { query: query('denied') } });
    expect(await getPermissionState()).toBe('blocked');
  });

  it('falls back to askable when the Permissions API is missing', async () => {
    // Geolocation still works; we simply cannot read the state without
    // prompting, and trying is what is available.
    vi.stubGlobal('navigator', { geolocation: {} });
    expect(await getPermissionState()).toBe('askable');
  });

  it('falls back to askable when the query itself throws (older Safari)', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {},
      permissions: { query: vi.fn().mockRejectedValue(new TypeError('unsupported')) },
    });
    expect(await getPermissionState()).toBe('askable');
  });

  it('reports unknown when there is no geolocation provider at all', async () => {
    // Never 'blocked': claiming a denial nobody made is what the status dot
    // would paint red.
    vi.stubGlobal('navigator', {});
    expect(await getPermissionState()).toBe('unknown');
  });

  it('never probes for position — a status read must not raise the prompt', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition },
      permissions: { query: query('prompt') },
    });
    await getPermissionState();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
});

describe('onPermissionStateChange', () => {
  it('reports the browser unblocking the site, which happens off-page', async () => {
    // The unblock is done in the browser's own site settings with this page
    // still open — no focus change, no reload. Without this the screen keeps
    // saying "Blocked" after the runner has just fixed it.
    const listeners: (() => void)[] = [];
    const status = {
      state: 'granted',
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => {},
    };
    vi.stubGlobal('navigator', {
      geolocation: {},
      permissions: { query: vi.fn().mockResolvedValue(status) },
    });
    const seen: string[] = [];
    onPermissionStateChange((next) => seen.push(next));
    await Promise.resolve();
    await Promise.resolve();
    for (const fire of listeners) fire();
    expect(seen).toEqual(['granted']);
  });

  it('is a no-op without the Permissions API rather than throwing', () => {
    vi.stubGlobal('navigator', { geolocation: {} });
    expect(() => onPermissionStateChange(() => {})()).not.toThrow();
  });
});
