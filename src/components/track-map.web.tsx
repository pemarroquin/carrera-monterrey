// Track tab map — WEB. A real Mapbox GL JS map, not the static image the
// native file uses.
//
// This split exists because of a hard API limit, not preference: the Static
// Images API cannot render Mapbox Standard styles (the `imports`-based kind
// Studio creates by default) — it returns a blank image, no error. GL JS
// renders them fine, so the custom Studio style can only be used here. See
// constants/map.ts.
//
// GL JS also buys what a baked PNG structurally cannot: a gradient route
// line, an extruded 3D fence, and a camera that moves. The route renders in
// two pieces while running — see fence-3d.ts for the split.
//
// mapbox-gl is loaded by dynamic import and its CSS by a runtime <link>, both
// copied from route-map.web.tsx — see that file's header for why the CSS
// cannot be a JS import (Metro hoists every CSS module into one global,
// render-blocking stylesheet regardless of the import being dynamic).
//
// Every custom layer sets a `slot` and `*-emissive-strength` — see
// constants/map.ts's MAP_SLOT_ROUTE / MAP_SLOT_FILL / EMISSIVE_STRENGTH_FULL.
// Standard shades custom layers by the style's own light preset like any
// basemap layer (this style's Standard import sets lightPreset: 'night'),
// which is why every route/wall colour used to render at roughly a third of
// its intended brightness (P3 §7a).
//
// There is exactly ONE traced line on this map: ROUTE_SRC (plus its blurred
// glow twin), fed the live edge of the newest leg. There used to be a second
// pair — an enclosure fill and its gradient rim, built by buildFence() over
// the whole growing path. buildFence AUTO-CLOSES the path into a ring, so
// drawing that ring's boundary as a LineString put three artefacts on screen
// at once (reported with screenshots 2026-09-08):
//   1. a straight chord from the runner's live position back to the start,
//      cutting across ground nobody ran (through the middle of a park);
//   2. what looked like a duplicated route — the ring traces the path
//      itself, so an out-and-back drew BOTH its sides alongside ROUTE_SRC,
//      three parallel lines for one run;
//   3. a fill shading the enclosed area as claimed, which under the tile
//      coverage model it is not.
// Territory is the H3 tile footprint (TILES_SRC/WALL_SRC), never an
// enclosure — see gap-policy.ts. Both the native track map and the saved-run
// summary (fence-map.web.tsx) already draw tiles only; this brings the web
// track map to parity. Do not reintroduce an enclosure outline here.
//
// One thing animates continuously while a session is live, so the map
// doesn't read as flat/static even when the runner is standing still: the
// route line flows ROUTE_GRADIENT along itself via gradient-flow.ts. It's a
// plain setInterval timer, not a requestAnimationFrame loop — see the
// pulse-dot comment below.
import { cellsToMultiPolygon } from 'h3-js';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import type { GeoJSONSource, Map as MapboxMap, Marker } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import type { Feature, FeatureCollection } from 'geojson';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Spacing } from '@/constants/theme';
import {
  AUTO_RETURN_IDLE_MS,
  type CameraMode,
  EMISSIVE_STRENGTH_FULL,
  FENCE_LAG_M,
  FENCE_RISE_MS,
  FENCE_WALL_COLOR,
  FENCE_WALL_HEIGHT_M,
  FENCE_WALL_OPACITY,
  FOLLOW_OFFSET_RATIO,
  MAP_DEFAULT_ZOOM,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  MAX_BEARING_STEP_DEG,
  MIN_BEARING_SEPARATION_M,
  OVERVIEW_FIT_PADDING_PX,
  ROUTE_GLOW_BLUR,
  ROUTE_GLOW_OPACITY,
  ROUTE_GLOW_WIDTH,
  ROUTE_GRADIENT,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  SESSION_FLY_MS,
  SESSION_PITCH,
  SESSION_ZOOM,
  TILE_FILL_OPACITY,
  ZOOM_STEP,
} from '@/constants/map';
import {
  bearingFromPath,
  boundsOfPath,
  followOffsetPx,
  overviewPadding,
  smoothBearing,
  type ChromeInsets,
} from '@/lib/camera';
import { splitTrailing } from '@/lib/fence-3d';
import { splitLegs, type TimedPoint } from '@/lib/gap-policy';
import { lineGradientExpression } from '@/lib/fence-draw';
import { startGradientFlow } from '@/lib/gradient-flow';
import { useRegion } from '@/lib/region-context';
import { type LatLng } from '@/lib/territory';


/** No chrome over the map — the old behaviour, and what a caller that
 *  passes no insets gets. Module-level so the identity is stable and the
 *  mirroring effect below doesn't re-run every render. */
const NO_CHROME: ChromeInsets = { top: 0, bottom: 0 };

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const ROUTE_SRC = 'run-route';
const WALL_SRC = 'run-wall';
const TILES_SRC = 'run-tiles';
const PULSE_STYLE_ID = 'track-pulse-style';

/**
 * The claimed cells as ONE dissolved shape, not one polygon per hexagon.
 *
 * cellsToMultiPolygon merges the set and returns its outline(s), holes and
 * all — the same call enclosure.ts uses to find enclosed ground, so the two
 * can never disagree about where the boundary is.
 *
 * Why it matters here: enclosure changed the scale of this. A run used to
 * claim a few hundred cells along its path; a 10 km loop now claims ~25,900,
 * and handing Mapbox 25,900 separate polygons every recompute is a lot of
 * geometry for a shape that is visually one region. Dissolving also removes
 * the internal edges, so the territory reads as one area rather than a
 * quilt.
 *
 * The rings come back GeoJSON-wound ([lng, lat]) and already closed, which
 * is why this no longer repeats the first point the way the per-hexagon
 * version had to.
 */
function tileFeatureCollection(cells: string[]): FeatureCollection {
  if (cells.length === 0) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: cellsToMultiPolygon(cells, true).map(
      (rings): Feature => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: rings },
      }),
    ),
  };
}

interface TrackMapProps {
  /** The recorded path. Timestamped, and that is load-bearing: the gap caps
   *  that decide where this path must NOT be drawn as a continuous line are
   *  a function of elapsed time as well as distance (see splitLegs). A plain
   *  LatLng[] here is what let the route render straight across an
   *  unrecorded background gap. */
  points: TimedPoint[];
  running: boolean;
  /** A real fix, or null. Never a fallback — see use-current-location.ts. */
  here: LatLng | null;
  /** Pixels of app chrome drawn OVER the map (live stats block up top, the
   *  floating tab bar at the bottom). The camera frames against the band
   *  these leave visible rather than the whole container — see
   *  camera.ts's visibleBand. Optional: omitted means "nothing covers the
   *  map", which is the old behaviour. */
  chromeInsets?: ChromeInsets;
  /** True once a session is live: drives the fly-in and the 3D framing. */
  active: boolean;
  /** This run's fence colour ('#rrggbb') — see FENCE_COLOR_SETS. */
  fenceColor: string;
  /** Tile Coverage brief §6 step 4 — this session's live covered H3 cells,
   *  computed and throttled in index.tsx and passed down ready to render.
   *  Rendered via its OWN effect, deliberately separate from the
   *  points-driven effect that owns ROUTE_SRC/the camera — see this
   *  component's own report note on why that effect was left untouched
   *  rather than folding this in. */
  tiles: string[];
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  unavailable: string;
  /** Accessibility labels for the camera controls (Task D / P4) — passed in
   *  pre-translated, matching every other string on this component.
   *  recenterLabel is shown while in overview mode (tapping switches to
   *  follow); overviewLabel is shown while in follow mode (tapping switches
   *  to overview) — the single control cycles between the two modes. */
  zoomInLabel: string;
  zoomOutLabel: string;
  recenterLabel: string;
  overviewLabel: string;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

// The "you are here" pulse. A keyframed DOM element rather than a GL layer:
// GL has no repeating animation primitive, so driving one would mean a
// requestAnimationFrame loop repainting the map every frame for the whole
// run — this costs nothing and the compositor handles it.
function ensurePulseStyle() {
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
@keyframes track-pulse {
  0%   { transform: scale(1);   opacity: 0.55; }
  70%  { transform: scale(3.2); opacity: 0;    }
  100% { transform: scale(3.2); opacity: 0;    }
}
.track-dot { position: relative; width: 16px; height: 16px; }
.track-dot__core {
  position: absolute; inset: 0; border-radius: 50%;
  background: ${ROUTE_LINE_COLOR};
  border: 2.5px solid #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,0.45);
}
.track-dot__halo {
  position: absolute; inset: 0; border-radius: 50%;
  background: ${ROUTE_LINE_COLOR};
  animation: track-pulse 2s ease-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .track-dot__halo { animation: none; opacity: 0; }
}`;
  document.head.appendChild(style);
}

export function TrackMap({
  points,
  running,
  here,
  chromeInsets,
  active,
  fenceColor,
  tiles,
  placeholder,
  placeholderColor,
  unavailable,
  zoomInLabel,
  zoomOutLabel,
  recenterLabel,
  overviewLabel,
}: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const readyRef = useRef(false);
  const flownRef = useRef(false);
  // The "feels alive even standing still" animation timer — a JS interval,
  // not a requestAnimationFrame loop (see the pulse-dot comment below for
  // why that distinction matters for the length of a run). Armed and cleared
  // by the `active` effect further down, so it only ever runs mid-session
  // and never on the idle pre-run map.
  //
  // The gradient flow owns its own timer (gradient-flow.ts); this holds its
  // stopper rather than an interval id.
  const routeFlowStopRef = useRef<(() => void) | null>(null);

  // Camera control during a session (Task D / P4). preferredZoom is a REF,
  // not state: the zoom buttons (and now pinch-zoom, see the gesture effect
  // below) write it and the camera-apply function reads it imperatively
  // from inside an event listener/timeout, seconds after the render that
  // set it — a ref avoids both a stale closure and re-subscribing every
  // listener on every zoom tap. Survives a session (not reset on
  // pause/resume) because it is a user preference, not per-leg state.
  const preferredZoomRef = useRef(SESSION_ZOOM);
  // The runner's latest known position, mirrored from the "feed
  // coordinates in" effect below (the same `head` it already computes) so
  // the auto-return glide — fired from a setTimeout, not a render — always
  // targets where the runner IS, not wherever they were when the 5s timer
  // was scheduled.
  const headRef = useRef<LatLng | null>(null);
  // Mirrors `points` for the same reason headRef mirrors `here` — overview
  // mode's bounds fit is computed from inside the same imperative call sites
  // (auto-return timeout, mode-toggle tap) that read headRef, so it needs
  // the same "always current, no stale closure" treatment.
  const pointsRef = useRef<LatLng[]>([]);
  const autoReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the moment a user gesture arms auto-return until the camera is
  // next placed authoritatively (the timer firing, a mode toggle, a recenter
  // tap, a new session). While it's true the per-fix camera effect below
  // stays hands-off, so a deliberate pan/pinch survives for the whole
  // AUTO_RETURN_IDLE_MS window instead of being undone by the next GPS fix.
  //
  // It applies in BOTH modes, and that is the fix for "it's almost as if it
  // doesn't allow you to explore the map" (Pedro, 2026-09-08). It used to be
  // checked only when cameraMode was 'overview' — so in follow mode, which
  // is what every session STARTS in, the per-fix effect re-centred on the
  // runner ~1-2s after a pan and AUTO_RETURN_IDLE_MS never came into it at
  // all. Panning away in follow mode was effectively impossible.
  //
  // Follow mode still stays glued fix to fix; nothing sets this ref unless
  // the runner actually touches the map (dragend/zoomend with a real
  // originalEvent — see the auto-return effect below).
  const manualPendingRef = useRef(false);

  // P4: cameraMode replaces the old cameraOffTarget visibility flag
  // entirely. The control is now ALWAYS rendered while a session is active
  // (see the render below) — its icon/label reflect whichever mode is
  // CURRENT, and a tap cycles to the other one. cameraModeRef mirrors the
  // state for the same stale-closure reason as preferredZoomRef/headRef:
  // read from the gesture handlers' setTimeout and from the marker's
  // dblclick listener, not just from render.
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const cameraModeRef = useRef<CameraMode>('follow');
  // Smoothed camera heading for follow mode (degrees, 0-360) — null until
  // bearingFromPath (camera.ts) has enough separation to derive one. Reset
  // to null at the start of each session (see the `active` effect below):
  // a new session has no known direction yet, and the old one's heading is
  // meaningless for it.
  const bearingRef = useRef<number | null>(null);
  // Mirrored into a ref for the same reason headRef/pointsRef are: the
  // camera is applied from setTimeout and Mapbox event listeners, not only
  // from a render, so it must read the current insets rather than the ones
  // captured when applyCameraForMode was defined.
  const chromeInsetsRef = useRef<ChromeInsets>(chromeInsets ?? NO_CHROME);
  useEffect(() => {
    chromeInsetsRef.current = chromeInsets ?? NO_CHROME;
  }, [chromeInsets]);
  const { region } = useRegion();

  // Applies whichever camera cameraModeRef.current currently names — the
  // ONE definition the continuous while-running follow, the auto-return
  // glide, the mode-toggle tap, and the pin double-tap all share, so
  // "deliberate zoom survives, stray drift doesn't, and both modes glide to
  // the same place their button promised" can't drift out of sync between
  // the four entry points.
  const applyCameraForMode = useCallback((durationMs: number) => {
    const map = mapRef.current;
    if (!map) return;
    // Every caller here is an authoritative "the camera belongs at the
    // current mode's target NOW" — the idle timer firing, a mode toggle, a
    // recenter tap. So both halves of the browse hold are released in ONE
    // place: the pending timer and the ref the per-fix effect reads. Leaving
    // the ref set here is what would strand that effect hands-off forever
    // (its timer having been cleared, nothing left to reset the ref).
    if (autoReturnTimerRef.current) {
      clearTimeout(autoReturnTimerRef.current);
      autoReturnTimerRef.current = null;
    }
    manualPendingRef.current = false;

    if (cameraModeRef.current === 'overview') {
      const head = headRef.current;
      const path = head ? [...pointsRef.current, head] : pointsRef.current;
      const bounds = boundsOfPath(path);
      if (!bounds) return; // nothing recorded yet — nothing to fit
      map.fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        {
          // Framed inside the band the chrome leaves visible — a uniform
          // padding fits the top of the route into the space the timer is
          // drawn over, and the bottom into the tab bar.
          padding: overviewPadding(chromeInsetsRef.current, OVERVIEW_FIT_PADDING_PX),
          bearing: 0,
          pitch: 0,
          duration: durationMs,
        },
      );
      return;
    }

    const head = headRef.current;
    if (!head) return; // nothing to target yet
    const containerHeight = containerRef.current?.clientHeight ?? 0;
    map.easeTo({
      center: [head.lng, head.lat],
      zoom: preferredZoomRef.current,
      pitch: SESSION_PITCH,
      // Falls back to the map's current bearing (not 0) when no heading has
      // been derived yet — standing still at the very start of a session
      // shouldn't snap the camera to north, it should just hold whatever
      // it's already at until a real course is known.
      bearing: bearingRef.current ?? map.getBearing(),
      // Pushes the runner toward the lower third of the VISIBLE band
      // (Mapbox's `offset` is screen-space pixels, not world-space) — see
      // followOffsetPx and FOLLOW_OFFSET_RATIO.
      offset: [0, followOffsetPx(containerHeight, chromeInsetsRef.current, FOLLOW_OFFSET_RATIO)],
      duration: durationMs,
    });
  }, []);

  // The mode-cycle button's tap handler. Updates the ref BEFORE calling
  // setCameraMode/applyCameraForMode — never inside a setState updater (a
  // documented trap in this codebase: a side effect inside an updater can
  // silently no-op under the React Compiler in production builds).
  const toggleCameraMode = useCallback(() => {
    const next: CameraMode = cameraModeRef.current === 'follow' ? 'overview' : 'follow';
    cameraModeRef.current = next;
    setCameraMode(next);
    applyCameraForMode(900); // clears the browse hold too — see its own comment
  }, [applyCameraForMode]);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const nextZoom = map.getZoom() + delta;
    // The button IS the deliberate zoom — record it as the new preference
    // before animating, so an auto-return firing mid-animation (a runner
    // taps zoom-out right as their 5s idle timer was about to fire) still
    // lands on the value they just chose, not the one before it.
    preferredZoomRef.current = nextZoom;
    map.easeTo({ zoom: nextZoom, duration: 300 });
  }, []);

  // Only ever a fallback for the *initial* camera, and only while no real fix
  // exists. The marker is a separate decision below — it is never placed on a
  // city centre, because a pin is a claim about where you are.
  const initialLat = here?.lat ?? region.lat;
  const initialLng = here?.lng ?? region.lng;

  // Built once. Re-creating the map when points change would tear down and
  // re-instantiate a WebGL context on every GPS fix.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      ensurePulseStyle();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        center: [initialLng, initialLat],
        zoom: MAP_DEFAULT_ZOOM,
        attributionControl: false,
      });
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;

        // Rotate/pitch gestures, gone entirely — not just during a session.
        // SESSION_PITCH is set once for the 3D look and a runner has no
        // reason to change it via gesture; on the idle (pre-session) map
        // pitch is already flat, so there is nothing legitimate to disable
        // FROM either way. This is the fix for the actual bug: one stray
        // pinch or two-finger drag used to permanently change the framing,
        // with no interaction detection and no way back (Pedro hit this
        // mid-run: "normal at first, then weird").
        map.dragRotate.disable();
        map.touchPitch.disable();
        map.touchZoomRotate.disableRotation(); // pinch-zoom itself stays on

        // lineMetrics is REQUIRED for line-gradient. Without it the paint
        // property is ignored silently and the line renders flat — which
        // looks like a styling mistake rather than a missing source option.
        map.addSource(ROUTE_SRC, {
          type: 'geojson',
          lineMetrics: true,
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addSource(WALL_SRC, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Tile Coverage brief §6 step 4 — this session's live tile fill, fed
        // by the `tiles` prop's own effect below (NOT the points-driven
        // effect that owns ROUTE_SRC — index.tsx already throttles the prop,
        // so this source just renders whatever it's handed).
        map.addSource(TILES_SRC, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: `${ROUTE_SRC}-glow`,
          type: 'line',
          source: ROUTE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ROUTE_LINE_COLOR,
            'line-width': ROUTE_GLOW_WIDTH,
            'line-blur': ROUTE_GLOW_BLUR,
            'line-opacity': ROUTE_GLOW_OPACITY,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });
        map.addLayer({
          id: ROUTE_SRC,
          type: 'line',
          source: ROUTE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-width': ROUTE_LINE_WIDTH,
            // Fallback for if line-gradient is ever rejected (unsupported
            // source, dropped lineMetrics, etc.) — Mapbox's default
            // line-color is #000000, and without this a rejected gradient
            // silently renders pure black instead of failing loudly. Never
            // fires today (the gradient renders — confirmed on device), but
            // costs nothing and matches the fix applied to the summary
            // outline below, which WAS silently falling back to black.
            'line-color': ROUTE_GRADIENT[0][1],
            // The static ramp is only what the line looks like BEFORE a
            // session arms the flow below — mid-run this property is
            // repainted every ROUTE_GRADIENT_FRAME_MS.
            'line-gradient': lineGradientExpression(),
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        // Tile Coverage brief §6 step 4/§5 — below everything else in
        // MAP_SLOT_FILL (added first, so it's the bottom-most fill layer)
        // so the wall/enclosure-fill scene-dressing above still reads as
        // distinct edges/rise on top of the real claimed-ground fill.
        map.addLayer({
          id: TILES_SRC,
          type: 'fill',
          source: TILES_SRC,
          slot: MAP_SLOT_FILL,
          paint: {
            // Default colour at mount, same as WALL_SRC below —
            // this component persists across sessions (it's not remounted
            // per-run), so the real per-run colour is applied by the
            // fenceColor-sync effect, not baked in here.
            'fill-color': FENCE_WALL_COLOR,
            'fill-opacity': TILE_FILL_OPACITY,
            'fill-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        // The fence. Height is animated per-feature via a paint transition
        // rather than a rAF loop: GL interpolates fill-extrusion-height on
        // the GPU, so the rise costs nothing on the main thread.
        map.addLayer({
          id: WALL_SRC,
          type: 'fill-extrusion',
          source: WALL_SRC,
          slot: MAP_SLOT_FILL,
          paint: {
            'fill-extrusion-color': FENCE_WALL_COLOR,
            'fill-extrusion-opacity': FENCE_WALL_OPACITY,
            'fill-extrusion-height': FENCE_WALL_HEIGHT_M,
            'fill-extrusion-base': 0,
            'fill-extrusion-height-transition': { duration: FENCE_RISE_MS, delay: 0 },
            'fill-extrusion-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });
        // "Feels alive even standing still" (mid-run, not idling — see the
        // dedicated effect below that arms it) — the route's gradient flow is
        // a plain setInterval, not requestAnimationFrame: see this file's
        // pulse-dot comment for why a per-frame GL repaint for the whole
        // length of a run is the specific trap being avoided. Each tick is
        // one cheap setPaintProperty call, not a geometry rebuild.

        const el = document.createElement('div');
        el.className = 'track-dot';
        el.innerHTML = '<div class="track-dot__halo"></div><div class="track-dot__core"></div>';
        // Double-tap the pin to re-center (Pedro's original idea) —
        // stopPropagation so a near-miss tap can't fall through to the
        // canvas underneath and trigger Mapbox's OWN built-in
        // double-click-to-zoom, which would zoom IN: the opposite of what
        // tapping the pin means here.
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          applyCameraForMode(900);
        });
        markerRef.current = new mapboxgl.Marker({ element: el });
        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      flownRef.current = false;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mount-only: later camera/marker changes move the existing map rather
    // than rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arms the route-colour-cycle timer ONLY while a session is active —
  // gated here, not inside the mount effect above, specifically because it
  // used to run from map mount to unmount regardless of whether a run was in
  // progress. Sitting on the Track tab with no run recording cost ~2.2
  // setPaintProperty calls per second, each forcing a map repaint,
  // indefinitely, on an empty source — directly undoing P0.1 bug 3, which
  // exists specifically to stop the idle screen burning battery (see
  // GeoWatchOptions.highAccuracy). This is a running app; the phone has to
  // survive 40+ minutes with the screen on. "Feels alive even standing
  // still" means standing still MID-RUN, not idling in the app.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !active) return;

    // The route flows its colours along itself. line-gradient has no
    // `-transition` support at all, so there is no GPU tween between
    // updates — every repaint lands exactly as drawn. That is why the flow
    // moves in many tiny steps rather than a few large ones; see
    // ROUTE_GRADIENT_FRAME_MS. The previous version rotated whole colour
    // stops and read as stepped.
    routeFlowStopRef.current = startGradientFlow((gradient) => {
      map.setPaintProperty(ROUTE_SRC, 'line-gradient', gradient);
    });

    return () => {
      routeFlowStopRef.current?.();
      routeFlowStopRef.current = null;
    };
  }, [active]);

  // Resets the camera mode to 'follow' at the start of every session — the
  // mode is session-scoped, not a persisted user setting. Gated to fire only
  // on the false→true edge (the effect body no-ops while active stays
  // false, and re-running on active→false does nothing either): a pause
  // mid-run does not touch `active`, so cameraMode survives a pause exactly
  // like preferredZoomRef already does. bearingRef also resets — a new
  // session has no known heading yet, and the previous session's is
  // meaningless for it.
  useEffect(() => {
    if (!active) return;
    cameraModeRef.current = 'follow';
    bearingRef.current = null;
    manualPendingRef.current = false;
    // Deferred by a tick, not called straight from the effect body — the
    // React Compiler's lint rule traces a call through and flags any
    // setState it can reach as a synchronous effect update. Same pattern as
    // index.tsx's checkpoint-load effect.
    const id = setTimeout(() => setCameraMode('follow'), 0);
    return () => clearTimeout(id);
  }, [active]);

  // Auto-return after AUTO_RETURN_IDLE_MS of no further interaction — gated
  // on `active` the same way as the animation timers above: this exists to
  // repair sweaty-hands drift mid-run, not to herd someone idly exploring
  // the pre-session map back to their own position. The re-center/overview
  // control is now ALWAYS rendered (see the render below) — this effect no
  // longer drives its visibility, only when the camera glides back to
  // whatever cameraModeRef currently names.
  //
  // `originalEvent` is present on Mapbox's own camera events ONLY when a
  // user gesture triggered them — absent for our own easeTo/flyTo calls
  // (the fly-in, the live follow, applyCameraForMode itself) — which is the
  // one reliable way to tell "the runner touched the map" apart from every
  // OTHER thing in this file that already moves the camera. Listens to
  // dragend/zoomend specifically, not moveend: rotate/pitch are disabled
  // above, so drag and pinch-zoom are the only gestures left that can
  // actually originate a user move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !active) return;

    const armAutoReturn = () => {
      if (autoReturnTimerRef.current) clearTimeout(autoReturnTimerRef.current);
      manualPendingRef.current = true;
      // Each new gesture RESTARTS the window (the clear above), so a runner
      // panning around for a while keeps the map theirs for
      // AUTO_RETURN_IDLE_MS after they stop, not after they started.
      autoReturnTimerRef.current = setTimeout(() => {
        applyCameraForMode(900); // resets manualPendingRef itself
      }, AUTO_RETURN_IDLE_MS);
    };

    // Typed `unknown`, not Mapbox's own per-event shape: 'dragend' and
    // 'zoomend' carry slightly different originalEvent union types, and the
    // 'void' branch some of these events' types include resolves (via
    // Mapbox's internal event-map machinery) to a bare {type, target} shape
    // with no originalEvent at all — no single object type satisfies every
    // variant. `unknown` is the top type, so this is valid for any of them;
    // narrowed by hand at runtime instead.
    const onUserDragEnd = (e: unknown) => {
      const originalEvent = (e as { originalEvent?: unknown } | null | undefined)?.originalEvent;
      if (!originalEvent) return;
      armAutoReturn();
    };
    // The core fix (P4): a pinch-zoom is a deliberate zoom exactly like the
    // +/- buttons, and must survive auto-return the same way — previously
    // ONLY the buttons wrote preferredZoomRef, so a runner who pinched to
    // max zoom got yanked back to SESSION_ZOOM 5s later with no way to tell
    // why, since the button that would explain it was hidden at the time
    // too (cameraOffTarget's old visibility bug, now gone).
    const onUserZoomEnd = (e: unknown) => {
      const originalEvent = (e as { originalEvent?: unknown } | null | undefined)?.originalEvent;
      if (!originalEvent) return;
      preferredZoomRef.current = map.getZoom();
      armAutoReturn();
    };

    map.on('dragend', onUserDragEnd);
    map.on('zoomend', onUserZoomEnd);

    return () => {
      map.off('dragend', onUserDragEnd);
      map.off('zoomend', onUserZoomEnd);
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    };
  }, [active, applyCameraForMode]);

  // Marker placement is deliberately gated on a REAL fix. Showing the pin at
  // the region fallback is what made it look like the location was wrong —
  // it was a city centre being presented as the runner's position.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !readyRef.current || !marker) return;

    // `here` first: during a session it's the tracker's RAW fix stream, which
    // stays fresh even while fixes are rejected for accuracy — the accepted
    // point list is only the fallback for the moment before any raw fix.
    const head = here ?? (points.length > 0 ? points[points.length - 1] : null);
    // Mirrored for applyCameraForMode (Task D / P4), which reads this from a
    // setTimeout/event listener rather than a render.
    headRef.current = head;
    if (!head) {
      marker.remove();
      return;
    }
    marker.setLngLat([head.lng, head.lat]).addTo(map);
  }, [points, here]);

  // Idle: keep the camera over the runner as they move, so the map isn't
  // still framing wherever they were when the tab opened. Skipped during a
  // session — the fly-in and follow below own the camera then.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || active || !here) return;
    map.easeTo({ center: [here.lng, here.lat], duration: 600 });
  }, [here, active]);

  // Fly in when a session starts: tilt into 3D and close on the runner. Runs
  // once per session (flownRef), so a later GPS fix doesn't re-trigger it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    if (!active) {
      flownRef.current = false;
      return;
    }
    if (flownRef.current) return;

    const target = points.length > 0 ? points[points.length - 1] : here;
    if (!target) return; // wait for a real position rather than flying to a city centre

    flownRef.current = true;
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: SESSION_ZOOM,
      pitch: SESSION_PITCH,
      // Explicit, not omitted: a second-or-later run in the same screen
      // session can start with the map still rotated from the PREVIOUS
      // run's follow mode (bearing is never reset back to 0 when a session
      // ends — same pre-existing gap as pitch, which also stays tilted).
      // Forcing 0 here gives every fly-in a deterministic, north-up start;
      // follow mode rotates it to the real course within a fix or two once
      // bearingRef has enough separation to derive one.
      bearing: 0,
      duration: SESSION_FLY_MS,
      essential: true,
    });
  }, [active, points, here]);

  // Per-run fence colour. The wall and tile layers are created once at mount
  // (before any session exists) with the default FENCE_WALL_COLOR, so the
  // run's own colour is applied as a paint update — cheap, no layer churn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty(WALL_SRC, 'fill-extrusion-color', fenceColor);
    map.setPaintProperty(TILES_SRC, 'fill-color', fenceColor);
  }, [fenceColor, active]);

  // Tile Coverage brief §6 step 4 — deliberately its OWN effect, not folded
  // into the points-driven effect below that owns ROUTE_SRC/the camera.
  // index.tsx already throttles `tiles`, so this just renders whatever it's
  // handed, same "own effect, untouched existing one" posture as
  // fence-map.web.tsx's rivalTiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    // ONE geometry drives both the flat fill and the raised wall: the tile
    // footprint. Tiles are H3 cells — they tile the plane and arrive
    // deduplicated (pathToTiles unions its direct and gap-filled sets), so
    // no two features can overlap and the opacity is uniform no matter how
    // many times a runner covers the same ground.
    //
    // The wall used to be a ribbon built along the path (buildWallPolygon).
    // A ribbon is ONE ring, so a path that doubles back makes that ring
    // self-intersect; Mapbox triangulates it and the overlapping triangles
    // blend twice, so running a street three times drew it three times as
    // dark. Reported 2026-09-07: the fence should mark total area, not how
    // often it was crossed.
    const footprint = tileFeatureCollection(tiles);
    (map.getSource(TILES_SRC) as GeoJSONSource | undefined)?.setData(footprint);
    (map.getSource(WALL_SRC) as GeoJSONSource | undefined)?.setData(footprint);
  }, [tiles]);

  // Feed coordinates in. setData on an existing source is the cheap path —
  // no layer or style churn, so the line simply extends.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    // Mirrored for applyCameraForMode's overview branch, which reads this
    // from a setTimeout/event listener rather than a render — same reason
    // headRef mirrors `here` in the marker effect above.
    pointsRef.current = points;

    // Heading-up source for follow mode. Derives a new bearing only when
    // there's enough separation to trust one (bearingFromPath returns null
    // otherwise — standing still, or too early in the run) and smooths
    // toward it along the shortest arc rather than snapping, so a jittery
    // fix doesn't wobble the map. The FIRST bearing of a session jumps
    // straight to its target (maxStepDeg: Infinity) — there's no prior
    // heading to smooth from.
    const rawBearing = bearingFromPath(points, MIN_BEARING_SEPARATION_M);
    if (rawBearing !== null) {
      bearingRef.current =
        bearingRef.current === null
          ? rawBearing
          : smoothBearing(bearingRef.current, rawBearing, MAX_BEARING_STEP_DEG);
    }

    // Legs FIRST, then the trailing split — `points` is one flat array with
    // no record of its own seams, so drawing straight from it joins the two
    // sides of an unrecorded gap with a straight line. On a real iOS Safari
    // run that showed as a chord from the start point to the runner's
    // current position, and again as the wall ribbon's two edges (reported
    // with screenshots 2026-09-07). splitLegs cuts exactly where
    // pathToTiles already refuses to bridge, so the drawn route and the
    // claimed tiles agree about what is a hole.
    const legs = splitLegs(points);
    // The live edge can only be in the newest leg, by definition.
    const newestLeg = legs.length > 0 ? legs[legs.length - 1] : [];
    // Only the live edge is wanted now — `settled` used to feed the wall
    // ribbon, which the tile footprint replaced.
    const { active: liveEdge } = splitTrailing(newestLeg, FENCE_LAG_M);

    const routeSource = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
    routeSource?.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: liveEdge.map((p) => [p.lng, p.lat] as [number, number]),
      },
    });

    // The wall is no longer built from this path — it is the tile footprint
    // now, fed by the tiles effect above. `settled` is still computed
    // because splitTrailing is what separates the live gradient edge from
    // everything behind it.
    //
    // Nothing else on this map is derived from `points`. The enclosure fill
    // and its rim used to be, via a throttled buildFence() right here; both
    // are gone — see this file's header for the three artefacts that ring
    // put on screen. Claimed ground is the tile footprint, and it arrives as
    // its own prop.

    // Camera only while recording: panning the map under someone reading
    // their finished route would fight them. Re-applies whichever mode is
    // current on every fix — follow re-centers on the runner (and rotates
    // to their latest smoothed bearing); overview re-fits the growing
    // bounds. Gated on `head` existing (not just `running`) for the same
    // reason as the marker effect above — there's nothing to center or fit
    // until a real fix exists.
    //
    // `manualPendingRef` suspends ALL of that for the AUTO_RETURN_IDLE_MS
    // window after a real pan/pinch, in BOTH modes. The check used to read
    // `cameraModeRef.current === 'overview' && manualPending`, which meant
    // follow mode — the mode every session starts in — re-centred on the
    // runner one fix (~1-2s) after any gesture. That is what made the map
    // impossible to explore mid-run: the pan landed, and the map took
    // itself back before you could read it (Pedro, 2026-09-08). The
    // armed auto-return timer, not this path, is what returns the camera.
    //
    // Note this cannot strand the camera: the ONLY thing that sets the ref
    // is a user gesture, and applyCameraForMode clears it on every
    // authoritative placement, including the timer's own.
    const head = here ?? points[points.length - 1];
    if (head && running && flownRef.current && !manualPendingRef.current) {
      applyCameraForMode(900);
    }
  }, [points, running, here, applyCameraForMode]);

  if (!TOKEN) {
    return (
      <View style={[styles.wrap, StyleSheet.absoluteFill, styles.centre]}>
        <Text style={[styles.placeholderText, { color: placeholderColor }]}>{unavailable}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {points.length === 0 && running && (
        <View style={styles.waiting}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}
      {/* Camera controls (Task D / P4) — reliable targets for sweaty hands
          where pinch is not. Bottom-right, matching where a thumb naturally
          rests; the app's own circular-button language (see index.tsx's
          RoundButton), not Mapbox's NavigationControl — foreign styling,
          and its compass would be meaningless with rotation disabled.

          The mode-cycle button is ALWAYS rendered here, never conditionally
          mounted — that was problem 1's root cause (a pinch to max zoom
          didn't write preferredZoomRef, so 5s later auto-return yanked the
          camera back to SESSION_ZOOM AND hid the button in the same
          instant). Its icon/label reflect the action a tap performs next,
          not the current mode: 'map' while in follow (tap → overview),
          'my_location' while in overview (tap → follow, reusing the same
          icon/copy as the old always-present recenter button). Fixed order
          — it and the +/- buttons never mount/unmount, so this cluster
          never shifts. */}
      {active && (
        <View style={styles.cameraControls} pointerEvents="box-none">
          {cameraMode === 'follow' ? (
            <MapButton label={overviewLabel} onPress={toggleCameraMode} ios="map" android="map" />
          ) : (
            <MapButton label={recenterLabel} onPress={toggleCameraMode} ios="location.fill" android="my_location" />
          )}
          <MapButton label={zoomInLabel} onPress={() => zoomBy(ZOOM_STEP)} ios="plus" android="add" />
          <MapButton label={zoomOutLabel} onPress={() => zoomBy(-ZOOM_STEP)} ios="minus" android="remove" />
        </View>
      )}
    </View>
  );
}

function MapButton({
  label,
  onPress,
  ios,
  android,
}: {
  label: string;
  onPress: () => void;
  ios: SFSymbol;
  android: AndroidSymbol;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.mapButton, { opacity: pressed ? 0.85 : 1 }]}>
      <Icon ios={ios} android={android} size={20} color="#FFFFFF" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  centre: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  waiting: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  placeholderText: { fontSize: 14, textAlign: 'center' },
  cameraControls: {
    position: 'absolute',
    right: Spacing.three,
    bottom: BottomTabInset + Spacing.three,
    alignItems: 'center',
    gap: Spacing.two,
  },
  // Same 52px circle + shadow language as index.tsx's RoundButton (the
  // pause/stop cluster), but semi-transparent dark rather than a solid
  // session-colour — these aren't destructive/session-critical actions,
  // and need to read against whatever's under them on the map, not just
  // the white idle scrim.
  mapButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.65)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
});
