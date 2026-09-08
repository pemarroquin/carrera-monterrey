// The Track tab's map — NATIVE. A live react-native-maps MapView (Apple Maps
// on iOS, Google on Android; both ship inside Expo Go), replacing the static
// Mapbox image this file used to render.
//
// The static image was why the tab felt broken on device: it had no camera —
// no fly-in when a session started, no follow while running — and the pin
// only moved when a whole new image URL was fetched, throttled and quantised,
// so on a phone it read as frozen on the first fix. A real MapView fixes all
// of that, and `showsUserLocation` adds the OS's own blue dot, which tracks
// the device continuously and independently of our JS fix stream.
//
// What this deliberately does NOT have, versus track-map.web.tsx: the custom
// Mapbox Studio style (a Mapbox GL SDK needs a dev client, which would break
// the Expo Go testing workflow), and the extruded 3D fence wall — no
// fill-extrusion primitive here, so the settled fence renders as a flat
// filled ribbon in the run's colour instead. The camera choreography — idle
// follow, fly-in to a tilted close-up on start, the follow/overview mode
// cycle while running — uses the same constants as web so both platforms
// feel like the same feature; see src/lib/camera.ts for the shared pure
// geometry.
//
// P4 native gap this file used to leave unfixed: it accepted zoomInLabel /
// zoomOutLabel / recenterLabel purely for interface parity with
// track-map.web.tsx and drew NO camera controls at all — a runner on
// Android/iOS had no way to zoom, recenter, or see the whole route, and the
// camera was hardcoded `heading: 0` (never rotated to face the direction of
// travel). Both are fixed below, reusing this repo's existing camera-control
// button language 1:1 with web.
import { cellToBoundary } from 'h3-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Spacing } from '@/constants/theme';
import {
  type CameraMode,
  FENCE_LAG_M,
  FENCE_RIBBON_WIDTH_M,
  FENCE_WALL_OPACITY,
  FOLLOW_LOOKAHEAD_M,
  GOOGLE_DARK_MAP_STYLE,
  MAP_DEFAULT_ZOOM,
  MAX_BEARING_STEP_DEG,
  MIN_BEARING_SEPARATION_M,
  OVERVIEW_FIT_PADDING_PX,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  SESSION_FLY_MS,
  SESSION_PITCH,
  SESSION_ZOOM,
  TILE_FILL_OPACITY,
  withAlpha,
  ZOOM_STEP,
} from '@/constants/map';
import { bearingFromPath, boundsOfPath, destinationPoint, smoothBearing } from '@/lib/camera';
import { buildWallPolygon, splitTrailing } from '@/lib/fence-3d';
import { splitLegs, type TimedPoint } from '@/lib/gap-policy';
import { gradientStrokeColors, ringToCoords } from '@/lib/fence-draw';
import { useRegion } from '@/lib/region-context';
import type { LatLng } from '@/lib/territory';

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
  /** True once a session is live: drives the fly-in and the tilted framing. */
  active: boolean;
  /** This run's fence colour ('#rrggbb') — see FENCE_COLOR_SETS. */
  fenceColor: string;
  /** Tile Coverage brief §6 step 4 — this session's live covered H3 cells,
   *  computed and throttled in index.tsx (same cadence as the enclosure
   *  ribbon below, LIVE_FILL_RECOMPUTE_MS/POINTS) and passed down ready to
   *  render, rather than recomputed inside this already-dense component.
   *  ADDITIVE: the existing ribbon/wall (buildWallPolygon/splitTrailing)
   *  is unchanged — see this file's own report note on why the live 3D/
   *  camera machinery here was treated as something to add alongside, not
   *  touch. */
  tiles: string[];
  /** Accepted for interface parity with track-map.web.tsx; the map is always
   *  dark here (MAP_ALWAYS_DARK) regardless. */
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  /** Web-only concern (missing Mapbox token); a MapView needs no token. */
  unavailable: string;
  /** Accessibility labels for the camera controls — pre-translated, matching
   *  every other string on this component. recenterLabel is shown while in
   *  overview mode (tapping switches to follow); overviewLabel is shown
   *  while in follow mode (tapping switches to overview). */
  zoomInLabel: string;
  zoomOutLabel: string;
  recenterLabel: string;
  overviewLabel: string;
}

// react-native-maps reads `zoom` on Google and `altitude` on Apple, and each
// platform ignores the other's field — so every camera carries both. The
// mapping is empirical, tuned to visually match the web map's zoom levels on
// a phone viewport: z15 ≈ 960m (neighbourhood), z17.5 ≈ 170m (street).
function altitudeForZoom(zoom: number): number {
  return 60 * Math.pow(2, 19 - zoom);
}

function cameraFor(center: LatLng, zoom: number, pitch: number, heading = 0) {
  return {
    center: { latitude: center.lat, longitude: center.lng },
    zoom,
    altitude: altitudeForZoom(zoom),
    pitch,
    heading,
  };
}

// Padding for MapView.fitToCoordinates in overview mode. EdgePadding wants
// all four sides, unlike web's single-number OVERVIEW_FIT_PADDING_PX for
// Mapbox GL's fitBounds — bottom gets extra so the fitted route doesn't
// duck under the camera-controls cluster / bottom tab bar sitting there.
const OVERVIEW_EDGE_PADDING = {
  top: OVERVIEW_FIT_PADDING_PX,
  right: OVERVIEW_FIT_PADDING_PX,
  bottom: OVERVIEW_FIT_PADDING_PX + BottomTabInset + 96,
  left: OVERVIEW_FIT_PADDING_PX,
};

export function TrackMap({
  points,
  running,
  here,
  active,
  fenceColor,
  tiles,
  placeholder,
  placeholderColor,
  zoomInLabel,
  zoomOutLabel,
  recenterLabel,
  overviewLabel,
}: TrackMapProps) {
  const mapRef = useRef<MapView | null>(null);
  const readyRef = useRef(false);
  const flownRef = useRef(false);
  const { region } = useRegion();

  // Camera mode — same product decision as web (track-map.web.tsx): the
  // control CYCLES between 'follow' (heading-up, tilted, zoomed to the
  // runner's own preference) and 'overview' (north-up/flat, fitted to the
  // whole run so far), session-scoped, defaulting to 'follow'. See
  // src/lib/camera.ts for the shared pure geometry both platforms use.
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  // A user preference, not per-leg state — survives a pause/resume within a
  // session, same as web's preferredZoomRef. Native has no reliable
  // cross-platform way to detect "was this zoom change a user pinch"
  // (react-native-maps' ChangeEvent.isGesture is Android-only and
  // undocumented for reliability — see this file's own report), so unlike
  // web, only the +/- buttons write this; native's own pinch-zoom keeps
  // working independently via react-native-maps' built-in gesture handling,
  // exactly as before, and simply isn't reflected back into this value.
  const preferredZoomRef = useRef(SESSION_ZOOM);
  // Smoothed camera heading (degrees, 0-360) — null until bearingFromPath
  // (camera.ts) has enough separation to derive one. Reset at the start of
  // each session, same as web: a new session has no known direction yet.
  const bearingRef = useRef<number | null>(null);

  // Only ever a fallback for the *initial* camera, and only while no real
  // fix exists — a map of your metro beats an empty rectangle, and it needs
  // no location permission. Nothing is ever pinned on it: the position dot
  // is the OS's own (showsUserLocation), which only renders on a real fix.
  const initial = here ?? { lat: region.lat, lng: region.lng };
  // Lazy state, not a ref: `initialCamera` is only read by MapView at mount,
  // but a ref can't be read during render (react-hooks/refs). The lazy
  // initializer freezes the mount-time framing; later camera moves go
  // through animateCamera, never through this value.
  const [initialCamera] = useState(() => cameraFor(initial, MAP_DEFAULT_ZOOM, 0));

  // Applies whichever `mode` names — the ONE definition the continuous
  // while-running update, the fly-in-adjacent follow, and the mode-toggle
  // button all share (mirrors applyCameraForMode in track-map.web.tsx,
  // adapted to react-native-maps' API). A plain function, not useCallback:
  // unlike web there is no long-lived Mapbox event listener capturing a
  // stale closure over this — every call site here is either a fresh
  // render's onPress handler or an effect whose own dependency array already
  // covers everything this function reads, so recreating it each render
  // costs nothing and needs no ref-mirroring for points/here.
  function applyCamera(mode: CameraMode, durationMs: number) {
    const map = mapRef.current;
    if (!map) return;

    if (mode === 'overview') {
      const path = here ? [...points, here] : points;
      const bounds = boundsOfPath(path);
      if (!bounds) return; // nothing recorded yet — nothing to fit
      map.fitToCoordinates(
        [
          { latitude: bounds.south, longitude: bounds.west },
          { latitude: bounds.north, longitude: bounds.east },
        ],
        { edgePadding: OVERVIEW_EDGE_PADDING, animated: true },
      );
      // fitToCoordinates has no bearing/pitch/duration parameters of its
      // own (a react-native-maps limitation, not a choice here) — flatten
      // to north-up/flat right after, so overview doesn't inherit follow's
      // tilt. NOT verified on a device: whether this reads as one motion or
      // two depends on how each platform's native SDK sequences an
      // in-flight fitToCoordinates against a second camera call in the same
      // tick, which nothing in this repo's test suite (environment: 'node',
      // no React renderer — see vitest.config.ts) can exercise.
      map.animateCamera({ heading: 0, pitch: 0 }, { duration: durationMs });
      return;
    }

    const head = here ?? points[points.length - 1];
    if (!head) return; // nothing to target yet
    const bearing = bearingRef.current;
    // "More map ahead than behind" (Apple/Google Maps turn-by-turn framing)
    // — react-native-maps has no pixel-offset camera option the way Mapbox
    // GL's `offset` does (see track-map.web.tsx), so this is done in
    // world-space instead: center on a point FOLLOW_LOOKAHEAD_M ahead of the
    // runner along their heading, rather than on the runner's own
    // coordinate. Falls back to centering exactly on the runner when no
    // bearing is known yet (session just started, standing still) — there
    // is no direction to look ahead along.
    const center = bearing !== null ? destinationPoint(head, bearing, FOLLOW_LOOKAHEAD_M) : head;
    map.animateCamera(cameraFor(center, preferredZoomRef.current, SESSION_PITCH, bearing ?? 0), {
      duration: durationMs,
    });
  }

  // Resets the camera mode to 'follow' (and clears the known bearing) at the
  // start of every session — session-scoped, not a persisted user setting.
  // Fires only on the false→true edge (a pause mid-run doesn't touch
  // `active`), matching web's identical effect.
  useEffect(() => {
    if (!active) return;
    bearingRef.current = null;
    // Deferred by a tick, not called straight from the effect body — the
    // React Compiler's lint rule traces a call through and flags any
    // setState it can reach as a synchronous effect update. Same pattern as
    // index.tsx's checkpoint-load effect.
    const id = setTimeout(() => setCameraMode('follow'), 0);
    return () => clearTimeout(id);
  }, [active]);

  // Heading-up source for follow mode. Derives a new bearing only when
  // there's enough separation to trust one and smooths toward it along the
  // shortest arc, so a jittery fix doesn't wobble the camera — same logic as
  // track-map.web.tsx's equivalent effect, sharing camera.ts's pure
  // functions. Declared BEFORE the camera-update effects below so
  // bearingRef is fresh by the time they read it in the same commit.
  useEffect(() => {
    if (!active) return;
    const rawBearing = bearingFromPath(points, MIN_BEARING_SEPARATION_M);
    if (rawBearing === null) return;
    bearingRef.current =
      bearingRef.current === null ? rawBearing : smoothBearing(bearingRef.current, rawBearing, MAX_BEARING_STEP_DEG);
  }, [points, active]);

  // Idle: keep the camera over the runner as they move, so the map isn't
  // still framing wherever they were when the tab opened. Skipped during a
  // session — the fly-in and follow below own the camera then.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || active || !here) return;
    map.animateCamera(cameraFor(here, MAP_DEFAULT_ZOOM, 0), { duration: 600 });
  }, [here, active]);

  // Fly in when a session starts: tilt and close on the runner. Runs once
  // per session (flownRef), so a later GPS fix doesn't re-trigger it. Always
  // flies to the FOLLOW framing regardless of cameraMode — a session always
  // starts in follow mode (see the reset effect above), so this and that
  // effect can never disagree about where the camera opens.
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
    map.animateCamera(cameraFor(target, preferredZoomRef.current, SESSION_PITCH), {
      duration: SESSION_FLY_MS,
    });
  }, [active, points, here]);

  // Camera only while recording: panning the map under someone reading
  // their finished route would fight them. Re-applies whichever mode is
  // current on every fix, mirroring track-map.web.tsx's equivalent effect.
  useEffect(() => {
    if (!running || !flownRef.current) return;
    const head = here ?? points[points.length - 1];
    if (!head) return;
    applyCamera(cameraMode, 900);
    // applyCamera is a fresh function each render closing over this same
    // render's points/here/cameraMode — including it in the deps array
    // would just restate points/here/cameraMode, which are already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, here, running, cameraMode]);

  const toggleCameraMode = () => {
    const next: CameraMode = cameraMode === 'follow' ? 'overview' : 'follow';
    setCameraMode(next);
    applyCamera(next, 900);
  };

  const zoomBy = (delta: number) => {
    preferredZoomRef.current += delta;
    // A manual zoom tap only makes sense in follow mode — overview's zoom
    // is derived from fitToCoordinates, and immediately overridden by it on
    // the next fix while running (see applyCamera's overview branch), so a
    // tap here while in overview would visibly do nothing useful.
    if (cameraMode === 'follow') applyCamera('follow', 300);
  };

  // Same split as web (fence-3d.ts): everything older than the trailing
  // FENCE_LAG_M "sets" into the fence — here a flat filled ribbon in this
  // run's colour, since react-native-maps has no fill-extrusion — while the
  // newest stretch stays the vibrant gradient line. The two share their join
  // point, so the line feeds visually into the fence.
  // Legs FIRST — `points` is one flat array with no record of its own seams,
  // so drawing straight from it joins the two sides of an unrecorded gap
  // with a straight line (reported on the web build with screenshots
  // 2026-09-07; the same flat-array assumption is here). splitLegs cuts
  // exactly where pathToTiles already refuses to bridge.
  const legs = useMemo(() => splitLegs(points), [points]);
  const { settled, active: liveEdge } = useMemo(
    // The live edge can only be in the newest leg, by definition.
    () => splitTrailing(legs.length > 0 ? legs[legs.length - 1] : [], FENCE_LAG_M),
    [legs],
  );
  // One ribbon per leg: every completed leg in full, plus the settled part
  // of the newest. A leg under 2 points yields no polygon and is dropped
  // rather than drawn as a degenerate sliver.
  const ribbons = useMemo(
    () =>
      [...legs.slice(0, -1), settled]
        .map((leg) => buildWallPolygon(leg, FENCE_RIBBON_WIDTH_M))
        .filter((wall): wall is NonNullable<typeof wall> => wall !== null)
        .map((wall) => ringToCoords(wall.geometry.coordinates[0])),
    [legs, settled],
  );
  const edgeCoords = useMemo(
    () => liveEdge.map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [liveEdge],
  );
  const edgeColors = useMemo(() => gradientStrokeColors(liveEdge.length), [liveEdge.length]);
  // Tile Coverage brief §6 step 4 — additive alongside the ribbon/edge
  // above, not a replacement: the ribbon is model-agnostic scene-dressing
  // (a visual "trail so far"), tiles are the actual claimed-ground fill.
  // cellToBoundary's default [lat,lng] pairs are already react-native-maps'
  // {latitude,longitude} order once mapped.
  const tilePolys = useMemo(
    () => tiles.map((h3) => ({ h3, coords: cellToBoundary(h3).map(([lat, lng]) => ({ latitude: lat, longitude: lng })) })),
    [tiles],
  );

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialCamera={initialCamera}
        onMapReady={() => {
          readyRef.current = true;
        }}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        pitchEnabled
        userInterfaceStyle="dark"
        customMapStyle={GOOGLE_DARK_MAP_STYLE}
      >
        {/* Tile Coverage brief §6 step 4 — rendered BELOW the ribbon so the
            ribbon's own stroke/fill still reads as the "trail so far" edge
            on top of the real claimed-ground fill. */}
        {tilePolys.map((p) => (
          <Polygon
            key={`tile-${p.h3}`}
            coordinates={p.coords}
            fillColor={withAlpha(fenceColor, TILE_FILL_OPACITY)}
            strokeColor={withAlpha(fenceColor, 0.0)}
            strokeWidth={0}
          />
        ))}
        {ribbons.map((coords, i) => (
          <Polygon
            // Index key: legs are positional and only ever appended to or
            // extended at the tail, so an index is stable for everything
            // before the newest leg and the newest one re-renders anyway.
            key={`ribbon-${i}`}
            coordinates={coords}
            fillColor={withAlpha(fenceColor, FENCE_WALL_OPACITY)}
            strokeColor={withAlpha(fenceColor, 0.9)}
            strokeWidth={1}
          />
        ))}
        {edgeCoords.length >= 2 && (
          <Polyline
            coordinates={edgeCoords}
            strokeWidth={ROUTE_LINE_WIDTH}
            strokeColor={ROUTE_LINE_COLOR}
            strokeColors={edgeColors}
            lineCap="round"
            lineJoin="round"
          />
        )}
      </MapView>

      {running && points.length === 0 && (
        <View style={styles.waiting}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}

      {/* Camera controls — same button language and bottom-right placement
          as track-map.web.tsx, added here for the first time (this map had
          none before P4). ALWAYS rendered while a session is active, never
          conditionally mounted, and in a fixed order — there is no
          visibility-flapping bug to dissolve here (native never had one),
          but the always-mounted contract matches web's for the same reason:
          a stable cluster reads as calmer than one whose buttons
          appear/disappear. */}
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
  ios: Parameters<typeof Icon>[0]['ios'];
  android: Parameters<typeof Icon>[0]['android'];
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
  waiting: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  placeholderText: { fontSize: 14, textAlign: 'center' },
  // Same geometry and colour language as track-map.web.tsx's own
  // cameraControls/mapButton styles — kept as a literal copy rather than a
  // shared import, matching this file's existing "no cross-import between
  // the platform components" split (see this file's header).
  cameraControls: {
    position: 'absolute',
    right: Spacing.three,
    bottom: BottomTabInset + Spacing.three,
    alignItems: 'center',
    gap: Spacing.two,
  },
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
