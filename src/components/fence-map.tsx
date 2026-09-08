// The end-of-session territory map — NATIVE. A fully interactive MapView
// (pan/zoom) showing every fence this runner has captured, with the run just
// finished highlighted: its own colour set, the ACTUAL RECORDED PATH as a
// gradient route, and the camera animating to frame it. Replaces the static
// Mapbox fence image the summary screen shipped with.
//
// The route line used to be the fence POLYGON's boundary (polygonRings(g)),
// not the path — structurally wrong two ways, both visible on a real out-
// and-back run (Web-First Pilot follow-up, reported by Pedro): a thin sliver
// polygon's boundary is two roughly-parallel strands that read as two
// unrelated routes, and buildFence's unkink/union step can return a
// MultiPolygon for any self-crossing run, which polygonRings then emits as
// one ring PER LOBE — literally disconnected segments. The route is now
// drawn from the masked path (never the raw one — see index.tsx) as its own
// Polyline, and the polygon's boundary is demoted to a thin, translucent,
// flat-coloured outline that still communicates the claimed shape without
// competing with the route for "this is where I ran".
//
// Past fences render muted, each in ITS run's colour (fenceColorForRun of
// its stored started_at — the same derivation every other screen uses), so
// territories stay tellable apart without a legend.
import { cellToBoundary, cellsToMultiPolygon } from 'h3-js';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';
import type { MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { splitLegs, type TimedPoint } from '@/lib/gap-policy';
import {
  fenceColorForRun,
  GOOGLE_DARK_MAP_STYLE,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  TILE_DISSOLVE_THRESHOLD,
  TILE_FILL_OPACITY,
  TILE_RIVAL_COLOR,
  TILE_RIVAL_FILL_OPACITY,
  withAlpha,
  ZOOM_STEP,
} from '@/constants/map';
import { gradientStrokeColors, polygonRings, ringToCoords, type MapCoord } from '@/lib/fence-draw';
import type { MyFence } from '@/lib/territory-sync';

interface FenceMapProps {
  /** The fence just captured — no longer filled (see the `tiles` prop
   *  below, brief §6 step 4), but still used for its outline and to frame
   *  the camera. Still required, not optional: buildFence isn't deleted
   *  this pass (brief §4) and this is what the outline/fitBounds read. */
  geometry: GeoPolygon | MultiPolygon;
  /** The recorded route, MASKED (privacy-zone.ts) — never the raw path. This
   *  is a shareable surface; the whole reason privacy-zone trimming exists
   *  is so start/end aren't exposed here.
   *
   *  Timestamped, and that is load-bearing: a saved run keeps the gaps it
   *  was recorded with, and the caps deciding where this path must NOT be
   *  drawn as one continuous line are a function of elapsed time as well as
   *  distance (see splitLegs). */
  path: TimedPoint[];
  /** Tile Coverage brief §6 step 4 — this run's covered H3 cells (DEFAULT_TILE_RES,
   *  tiles.ts's pathToTiles), rendered as the fill that used to be the
   *  enclosure polygon's. This is what actually reads as "your territory"
   *  now; the polygon above is demoted to a thin outline (see the render
   *  below) precisely because a giant enclosure fill next to a small tile
   *  cluster is the exact visual this whole brief exists to stop showing
   *  (see index.tsx's legacyArea line for where the old number still lives
   *  on this screen). */
  tiles: string[];
  /** Tile Coverage brief §5 — cells this run crossed that were already
   *  someone else's by claim time (territory-sync.ts's claimTiles;
   *  TileClaimResult.rivalCells). Rendered in TILE_RIVAL_COLOR, muted, so
   *  contested ground reads at a glance. Empty until the upload resolves —
   *  see index.tsx's `tileClaim` state, which is null (so this is `[]`)
   *  while a save is still in flight. */
  rivalTiles: string[];
  /** Its colour ('#rrggbb'), derived from the session's startedAt. */
  color: string;
  /** Previously-captured fences, rendered muted in their own colours. May
   *  include the just-saved run itself after a successful upload — pass its
   *  id via `excludeId` so it isn't drawn twice. */
  others: MyFence[];
  excludeId?: string | null;
  /** Zoom +/- and re-fit controls, bottom-right — see fence-map.web.tsx's
   *  own doc comment on the same prop. */
  controls?: { zoomInLabel: string; zoomOutLabel: string; recenterLabel: string };
}

const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };
// The fence boundary's subordinate weight, now that the route carries the
// gradient — mirrors the muted "past fence" outline treatment (strokeWidth
// 1, alpha 0.5) so the just-finished fence's boundary reads as claimed
// territory, not as the run.
const OUTLINE_WIDTH = 1.5;
const OUTLINE_ALPHA = 0.55;

export function FenceMap({
  geometry,
  path,
  tiles,
  rivalTiles,
  color,
  others,
  excludeId,
  controls,
}: FenceMapProps) {
  const mapRef = useRef<MapView | null>(null);

  const highlightRings = useMemo(() => polygonRings(geometry), [geometry]);
  const highlightPolys = useMemo(
    () =>
      highlightRings.map((rings) => ({
        outer: ringToCoords(rings[0]),
        holes: rings.slice(1).map(ringToCoords),
      })),
    [highlightRings],
  );
  // Tile Coverage brief §6 step 4/§5 — cellToBoundary returns [lat,lng]
  // pairs by default (h3-js v4), which is already react-native-maps'
  // {latitude,longitude} order once mapped — no GeoJSON [lng,lat] flip
  // needed here, unlike the web/GL version.
  // Individual hexagons up to TILE_DISSOLVE_THRESHOLD, then the dissolved
  // form — the summary is where the tiles ARE the score and worth seeing
  // one by one, but a large loop must not turn it into a slideshow. Native
  // matters more here than web: this mounts a <Polygon> COMPONENT per
  // feature rather than handing a layer one collection.
  //
  // Holes are dropped when dissolving: react-native-maps takes them as a
  // separate prop, and enclosed ground is claimed ground here anyway.
  const tilePolys = useMemo(
    () =>
      tiles.length > TILE_DISSOLVE_THRESHOLD
        ? cellsToMultiPolygon(tiles).map((rings, i) => ({
            h3: `region-${i}`,
            coords: rings[0].map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
          }))
        : tiles.map((h3) => ({
            h3,
            coords: cellToBoundary(h3).map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
          })),
    [tiles],
  );
  const rivalTilePolys = useMemo(
    () =>
      rivalTiles.map((h3) => ({
        h3,
        coords: cellToBoundary(h3).map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
      })),
    [rivalTiles],
  );
  // The ROUTE — the actual recorded path, not the fence boundary. Same
  // per-vertex gradient sampling as the live map's edge (track-map.tsx),
  // so the two screens agree.
  // One polyline per leg, not one across the whole path: a saved run keeps
  // its unrecorded gaps, and a single line joins both sides of one with a
  // straight chord across ground the runner never recorded (see splitLegs).
  const routeLegs = useMemo(
    () =>
      splitLegs(path)
        .filter((leg) => leg.length >= 2)
        .map((leg): MapCoord[] => leg.map((pt) => ({ latitude: pt.lat, longitude: pt.lng }))),
    [path],
  );

  const pastPolys = useMemo(
    () =>
      others
        // A null geometry is a fully-overtaken run — real history, but
        // there is no ground left to draw.
        .filter((f) => f.id !== excludeId && f.geometry !== null)
        .flatMap((f) => {
          const tint = fenceColorForRun(f.startedAtMs).color;
          return polygonRings(f.geometry!).map((rings, i) => ({
            key: `${f.id}:${i}`,
            outer: ringToCoords(rings[0]),
            holes: rings.slice(1).map(ringToCoords),
            tint,
          }));
        }),
    [others, excludeId],
  );

  // Frame the new fence once the map is laid out. fitToCoordinates with
  // animation doubles as the entrance move — the camera sweeping in on the
  // captured shape.
  const allHighlightCoords = useMemo(
    () => highlightPolys.flatMap((p) => p.outer),
    [highlightPolys],
  );
  useEffect(() => {
    // Deferred a tick: fitToCoordinates before the MapView has real layout
    // silently no-ops on Android.
    const id = setTimeout(() => {
      mapRef.current?.fitToCoordinates(allHighlightCoords, {
        edgePadding: FIT_PADDING,
        animated: true,
      });
    }, 350);
    return () => clearTimeout(id);
  }, [allHighlightCoords]);

  // The "recenter" control's target — same fitToCoordinates call as the
  // mount effect above, callable again after a manual pan/zoom.
  const refit = useCallback(() => {
    mapRef.current?.fitToCoordinates(allHighlightCoords, {
      edgePadding: FIT_PADDING,
      animated: true,
    });
  }, [allHighlightCoords]);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    void map.getCamera().then((camera) => {
      map.animateCamera({ ...camera, zoom: (camera.zoom ?? 15) + delta }, { duration: 300 });
    });
  }, []);

  const initialRegion = useMemo(() => regionAround(allHighlightCoords), [allHighlightCoords]);

  return (
    <View style={styles.wrap}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        userInterfaceStyle="dark"
        customMapStyle={GOOGLE_DARK_MAP_STYLE}
      >
        {pastPolys.map((p) => (
          <Polygon
            key={p.key}
            coordinates={p.outer}
            holes={p.holes.length > 0 ? p.holes : undefined}
            fillColor={withAlpha(p.tint, 0.16)}
            strokeColor={withAlpha(p.tint, 0.5)}
            strokeWidth={1}
          />
        ))}
        {/* Tile Coverage brief §6 step 4 — this run's real, honest fill.
            Replaces the enclosure polygon's fill (used to render here as a
            plain, uniform Polygon over `highlightPolys` — see the removed
            code this replaces in git history) precisely so a giant
            enclosure shape never again reads as "your territory" next to
            a small, real tile cluster. One Polygon per cell rather than
            one merged shape: react-native-maps has no fill-union
            primitive, and at this scale (a single run, typically well
            under a few hundred cells — see the §2.5 forgery guard's own
            bound) that's cheap. */}
        {tilePolys.map((p) => (
          <Polygon
            key={`tile-${p.h3}`}
            coordinates={p.coords}
            fillColor={withAlpha(color, TILE_FILL_OPACITY)}
            strokeColor={withAlpha(color, 0.0)}
            strokeWidth={0}
          />
        ))}
        {/* Rival tiles (brief §5) — cells this run crossed but couldn't
            claim. Muted neutral, never a FENCE_COLOR_SETS colour, so
            contested ground reads at a glance without a legend. */}
        {rivalTilePolys.map((p) => (
          <Polygon
            key={`rival-${p.h3}`}
            coordinates={p.coords}
            fillColor={withAlpha(TILE_RIVAL_COLOR, TILE_RIVAL_FILL_OPACITY)}
            strokeColor={withAlpha(TILE_RIVAL_COLOR, 0.0)}
            strokeWidth={0}
          />
        ))}
        {highlightPolys.map((p, i) => (
          // The fence BOUNDARY — subordinate now that the route (below)
          // carries the gradient: thin, translucent, flat colour. Still
          // communicates the claimed shape; must never again read as the
          // route.
          <Polyline
            key={`outline-${i}`}
            coordinates={p.outer}
            strokeWidth={OUTLINE_WIDTH}
            strokeColor={withAlpha(color, OUTLINE_ALPHA)}
            lineCap="round"
            lineJoin="round"
          />
        ))}
        {routeLegs.map((coords, i) => (
          // The ROUTE — the actual recorded (masked) path, drawn after the
          // outline so it renders on top wherever the two overlap. Each leg
          // gets its own gradient run, same as the web map's per-feature
          // line-progress.
          <Polyline
            key={`route-leg-${i}`}
            coordinates={coords}
            strokeWidth={ROUTE_LINE_WIDTH}
            strokeColor={ROUTE_LINE_COLOR}
            strokeColors={gradientStrokeColors(coords.length)}
            lineCap="round"
            lineJoin="round"
          />
        ))}
      </MapView>
      {controls && (
        <View style={styles.mapControls} pointerEvents="box-none">
          <MapButton
            label={controls.recenterLabel}
            onPress={refit}
            ios="map"
            android="map"
          />
          <MapButton
            label={controls.zoomInLabel}
            onPress={() => zoomBy(ZOOM_STEP)}
            ios="plus"
            android="add"
          />
          <MapButton
            label={controls.zoomOutLabel}
            onPress={() => zoomBy(-ZOOM_STEP)}
            ios="minus"
            android="remove"
          />
        </View>
      )}
    </View>
  );
}

// Byte-identical to track-map.tsx's own MapButton — see fence-map.web.tsx's
// matching comment on why this is duplicated rather than shared.
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

/** A Region loosely containing the coords — only the pre-fit first frame;
 *  fitToCoordinates supplies the real framing right after. */
function regionAround(coords: MapCoord[]) {
  if (coords.length === 0) {
    return { latitude: 0, longitude: 0, latitudeDelta: 0.05, longitudeDelta: 0.05 };
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const c of coords) {
    minLat = Math.min(minLat, c.latitude);
    maxLat = Math.max(maxLat, c.latitude);
    minLng = Math.min(minLng, c.longitude);
    maxLng = Math.max(maxLng, c.longitude);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.005),
    longitudeDelta: Math.max((maxLng - minLng) * 1.6, 0.005),
  };
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  mapControls: {
    position: 'absolute',
    right: Spacing.three,
    // Clears the floating pill tab bar, exactly as track-map's own
    // cameraControls does. A raw `bottom: 16` put the LOWEST button in this
    // column — zoom out — entirely inside the tab bar's 96px band, so on the
    // run-summary screen (this component's only caller, a tab screen) it read
    // as simply missing. Reported 2026-09-07.
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
