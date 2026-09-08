// The Territories tab's map — WEB. Every saved territory at once, fit to
// bounds around all of them (Pedro's call, 2026-09-02: "a single map view",
// however far the spread — no per-city scoping). Replaces myraces.tsx's old
// FlatList of fence-card rows.
//
// Two visual states, matching Pedro's explicit spec:
//   SAVED — full treatment, same as the just-finished-run map (fence-map.
//   web.tsx): this run's own colour (fenceColorForRun), a vertical
//   fill-extrusion wall with opacity (matching the live Track map's fence
//   wall — see constants/map.ts's FENCE_WALL_HEIGHT_M/OPACITY), the vibrant
//   route gradient, and a chromatic rim traced around the territory's own
//   boundary. Both gradients FLOW — the same continuous loop the live Track
//   map runs on its route and its fill rim (gradient-flow.ts), so a saved
//   territory reads as the same living surface as a session in progress,
//   with the ramp travelling once around each territory's edge.
//   PENDING (queued, not yet uploaded — see upload-queue.ts) — flat, no
//   extrusion, a single desaturated grey, dashed outline, no gradient. Reads
//   at a glance as "not confirmed yet" without inventing new iconography.
//   Promotes to SAVED automatically the moment its upload succeeds (the
//   caller just stops passing it in `queued` and starts passing it in
//   `fences` — this component has no idea a promotion happened, it just
//   re-renders from new props).
//
// Tapping either kind's fill fires onSelect(id, kind) — the caller (myraces.
// tsx) owns the detail bubble/card, this component only owns the map.
//
// SCALING CAVEAT, deliberate simplification: each fence gets its OWN
// Mapbox source + 2-3 layers (mirroring fence-map.web.tsx's per-feature
// gradient-route technique, looped) rather than one shared source for all
// of them — Mapbox's line-gradient needs per-feature `line-progress` via
// lineMetrics, which does not compose cleanly across a FeatureCollection of
// many LineStrings sharing one source. Fine for the tens of territories a
// runner accumulates early on; would need revisiting if that count grows
// into the hundreds (batch into a shared source, drop the per-run gradient
// in favour of a single flat colour per run).
import type { GeoJSONSource, Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Feature, FeatureCollection, MultiPolygon, Polygon as GeoPolygon } from 'geojson';

import {
  EMISSIVE_STRENGTH_FULL,
  FENCE_SHIMMER_STEP_MS,
  FENCE_WALL_HEIGHT_M,
  FENCE_WALL_OPACITY,
  fenceColorForRun,
  LIVE_FILL_OUTLINE_WIDTH,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  ROUTE_GRADIENT,
  ROUTE_GRADIENT_COLORS,
  ROUTE_LINE_WIDTH,
} from '@/constants/map';
import { lineGradientExpression } from '@/lib/fence-draw';
import { startGradientFlow } from '@/lib/gradient-flow';
import { outerRings, type LatLng } from '@/lib/territory';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const PENDING_COLOR = '#8E8E93'; // neutral grey — deliberately NOT one of FENCE_COLOR_SETS, so a pending item never reads as a confusing 7th run colour.
const PENDING_FILL_OPACITY = 0.14;
const PENDING_LINE_OPACITY = 0.7;

export interface TerritoryFeature {
  id: string;
  kind: 'saved' | 'pending';
  geometry: GeoPolygon | MultiPolygon;
  route: LatLng[] | null;
  /** Only used for SAVED (fenceColorForRun) — ignored for pending, which is
   *  always PENDING_COLOR regardless of startedAtMs. */
  startedAtMs: number;
}

interface TerritoriesMapProps {
  features: TerritoryFeature[];
  onSelect: (id: string, kind: 'saved' | 'pending') => void;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

function boundsOfAll(features: TerritoryFeature[]): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let any = false;
  for (const f of features) {
    for (const ring of outerRings(f.geometry)) {
      for (const [lng, lat] of ring) {
        any = true;
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }
  if (!any) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export function TerritoriesMap({ features, onSelect }: TerritoriesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const readyRef = useRef(false);
  // The freshest onSelect, so click handlers registered once at layer-add
  // time never close over a stale callback — same reasoning as fence-map.
  // web.tsx's dataRef, narrower because only the callback identity can go
  // stale here (feature data flows through setData() below, not closures).
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  // Which fence/pending ids currently have layers on the map — so the data
  // effect (below) can add layers for NEW ids and remove layers for ids
  // that dropped out (a delete, or a promotion from pending to saved swaps
  // one id's kind, which this treats as remove-then-add since the layer
  // IDs are kind-scoped).
  const mountedIdsRef = useRef<Set<string>>(new Set());
  // Every layer currently carrying a flowing line-gradient (each saved
  // territory contributes its rim and, when it has one, its route). Kept in
  // two shapes on purpose: keyed by the same `kind:id` as mountedIdsRef so
  // sync() can drop a removed feature's entries, and flattened so a tick
  // walks ONE array instead of a Map of arrays — that inner loop runs ~17
  // times a second for as long as the tab is open.
  //
  // The flow timer READS these refs rather than closing over a list, so
  // adding or deleting a territory never has to restart it: the next tick
  // simply paints a different set of layers.
  const flowIdsRef = useRef<Map<string, string[]>>(new Map());
  const flowLayersRef = useRef<string[]>([]);
  // The saved territories' extrusion layers, kept in the same shape as the
  // flow ids above so both are torn down by the same code paths.
  const shimmerIdsRef = useRef<Map<string, string[]>>(new Map());
  const shimmerLayersRef = useRef<string[]>([]);
  // The freshest feature list, read by sync() below rather than closed over.
  // The map's own 'load' handler is registered once, inside a mount effect
  // that can never see a later render's props — but it is also the FIRST
  // moment this component is able to draw anything, so it has to be able to
  // reach whatever `features` is by then, not what it was at mount.
  const featuresRef = useRef(features);
  // Declared BEFORE the effects that call sync(), so React runs it first in
  // the same commit and sync() never reads a stale list.
  useEffect(() => {
    featuresRef.current = features;
  }, [features]);

  /**
   * Brings the map's sources/layers in line with `featuresRef.current`, then
   * refits. Stable (`[]`) so both the load handler and the data effect can
   * call the same routine; everything it needs is in a ref for exactly that
   * reason.
   */
  const sync = useCallback(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const features = featuresRef.current;
    const nextIds = new Set(features.map((f) => `${f.kind}:${f.id}`));

    // Remove layers/sources for anything no longer present.
    for (const key of mountedIdsRef.current) {
      if (nextIds.has(key)) continue;
      removeFeatureLayers(map, key);
      mountedIdsRef.current.delete(key);
      flowIdsRef.current.delete(key);
      shimmerIdsRef.current.delete(key);
    }

    // Add layers/sources for anything new. Existing ones are left alone —
    // this component doesn't support editing a feature in place, only
    // add/remove, which matches every real change (a fetch/refetch always
    // hands back a fresh list; nothing mutates a fence's own geometry).
    for (const f of features) {
      const key = `${f.kind}:${f.id}`;
      if (mountedIdsRef.current.has(key)) continue;
      const { flowIds, shimmerIds } = addFeatureLayers(map, f, key, (id, kind) =>
        onSelectRef.current(id, kind),
      );
      mountedIdsRef.current.add(key);
      if (flowIds.length > 0) flowIdsRef.current.set(key, flowIds);
      if (shimmerIds.length > 0) shimmerIdsRef.current.set(key, shimmerIds);
    }

    flowLayersRef.current = [...flowIdsRef.current.values()].flat();
    shimmerLayersRef.current = [...shimmerIdsRef.current.values()].flat();

    const bounds = boundsOfAll(features);
    if (bounds) map.fitBounds(bounds, { padding: 64, duration: 900 });
  }, []);

  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        center: [-100.3, 25.67], // Monterrey-ish fallback; sync() below corrects it the instant data loads.
        zoom: 10,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
      });
      mapRef.current = map;
      map.on('load', () => {
        if (cancelled) return;
        readyRef.current = true;
        // The load handler draws the first frame itself. This is NOT
        // belt-and-braces for the data effect below — for the very first
        // (and, in practice, only) feature list this component ever
        // receives, it is the only sync() call that ever runs. FencesView doesn't mount this component until
        // the fetch has resolved with at least one feature, so `features`
        // already has data on the first render; the data effect fires
        // immediately after this mount effect, while this effect is still
        // suspended on `await import('mapbox-gl')` — so mapRef.current is
        // null, it bails, and nothing re-renders FencesView afterwards to
        // give it a second chance (the map branch has no RefreshControl,
        // no timer, no subscription). The Territories tab rendered a bare
        // basemap with zero territories, permanently, for anyone on web —
        // identical on screen to having no saved territory at all. The
        // native map has never had this bug: it renders its features
        // declaratively as MapView children (territories-map.tsx), with no
        // imperative sync to miss.
        sync();
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
      mountedIdsRef.current = new Set();
      flowIdsRef.current = new Map();
      flowLayersRef.current = [];
      shimmerIdsRef.current = new Map();
      shimmerLayersRef.current = [];
    };
    // Built once; `sync` is stable, and all data flows through the ref it
    // reads.
  }, [sync]);

  // Later changes to the feature list — a delete, a queued run promoted to
  // saved, a refetch after a new run. A no-op while the map is still
  // loading: the load handler above will run the same sync with the same
  // ref, which by then holds this list.
  useEffect(() => {
    sync();
  }, [features, sync]);

  // The gradient flow. ONE timer for the whole screen, however many
  // territories are on it — the expression is built once per tick and handed
  // to every animated layer, so the per-territory cost is a setPaintProperty
  // call (which only marks the layer dirty; GL still repaints once per
  // frame), not a timer each.
  //
  // Gated on there being at least one saved territory: a screen showing only
  // pending runs has nothing with a gradient on it, and an empty timer is
  // exactly the idle battery drain the live map's own `active` gate exists
  // to avoid. `hasSaved` (a boolean), not `features`, is the dependency —
  // re-running this on every refetch would restart the loop mid-cycle and
  // make the colours visibly jump back.
  const hasSaved = features.some((f) => f.kind === 'saved');
  useEffect(() => {
    if (!hasSaved) return;
    return startGradientFlow((gradient) => {
      const map = mapRef.current;
      if (!map || !readyRef.current) return;
      for (const id of flowLayersRef.current) {
        // The list is rebuilt in the same pass that adds and removes layers,
        // so this guard is never expected to fire — but a missing layer id
        // makes Mapbox fire an error event rather than throw, which at this
        // cadence would be a silent flood rather than a visible failure.
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-gradient', gradient);
      }
    });
  }, [hasSaved]);

  // The fill shimmer. ONE timer for the screen, same as the gradient flow
  // above and gated the same way — only saved territories have an extrusion,
  // so a screen of pending runs starts no timer at all.
  //
  // It only advances the hue; the smoothness is GL's, via the
  // `fill-extrusion-color-transition` set when the layer is added. Mapbox has
  // no positional gradient for fills (only lines take `line-gradient`, which
  // is why the OUTLINE carries the gradient across space), so the fill sweeps
  // the same wheel through time instead and the two read as one surface.
  useEffect(() => {
    if (!hasSaved) return;
    let step = 0;
    const id = setInterval(() => {
      const map = mapRef.current;
      if (!map || !readyRef.current) return;
      step = (step + 1) % ROUTE_GRADIENT_COLORS.length;
      shimmerLayersRef.current.forEach((layerId, i) => {
        // Phase-offset per territory so several on screen sweep in
        // succession rather than strobing in unison.
        const colour = ROUTE_GRADIENT_COLORS[(step + i) % ROUTE_GRADIENT_COLORS.length];
        // Same guard as the flow loop: a missing layer makes Mapbox fire an
        // error event rather than throw, which at this cadence would be a
        // silent flood.
        if (map.getLayer(layerId)) map.setPaintProperty(layerId, 'fill-extrusion-color', colour);
      });
    }, FENCE_SHIMMER_STEP_MS);
    return () => clearInterval(id);
  }, [hasSaved]);

  if (!TOKEN) return null;

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </View>
  );
}

/**
 * Adds one feature's sources/layers and returns the ids of every layer that
 * carries a flowing `line-gradient` — the caller collects those so one timer
 * can paint all of them (see flowIdsRef).
 */
function addFeatureLayers(
  map: MapboxMap,
  f: TerritoryFeature,
  key: string,
  onSelect: (id: string, kind: 'saved' | 'pending') => void,
): { flowIds: string[]; shimmerIds: string[] } {
  const fillSrc = `terr-fill-${key}`;
  const routeSrc = `terr-route-${key}`;
  const rimSrc = `terr-rim-${key}`;
  const color = f.kind === 'saved' ? fenceColorForRun(f.startedAtMs).color : PENDING_COLOR;
  const flowIds: string[] = [];
  // Saved territories only — a pending run has no per-run colour and must
  // keep reading as "not confirmed" rather than joining the shimmer.
  const shimmerIds: string[] = [];

  map.addSource(fillSrc, {
    type: 'geojson',
    data: { type: 'Feature', properties: { id: f.id, kind: f.kind }, geometry: f.geometry },
  });

  if (f.kind === 'saved') {
    // Vertical wall with opacity — matches the live Track map's fence
    // (track-map.web.tsx's WALL_SRC) and the just-finished-run map (fence-
    // map.web.tsx), per Pedro's explicit ask: a saved territory should look
    // "exactly the same as when it shows when run session is recorded".
    map.addLayer({
      id: `${fillSrc}-extrusion`,
      type: 'fill-extrusion',
      source: fillSrc,
      slot: MAP_SLOT_FILL,
      paint: {
        'fill-extrusion-color': color,
        // The shimmer's smoothness lives HERE, not in a render loop: the
        // timer only sets the next hue, and GL interpolates across this
        // duration on the GPU. Same technique as the live map's opacity
        // breathe — a rAF loop repainting a map layer 60 times a second is a
        // battery cost, and this is a screen a runner may leave open.
        'fill-extrusion-color-transition': { duration: FENCE_SHIMMER_STEP_MS, delay: 0 },
        'fill-extrusion-height': FENCE_WALL_HEIGHT_M,
        'fill-extrusion-opacity': FENCE_WALL_OPACITY,
        'fill-extrusion-emissive-strength': EMISSIVE_STRENGTH_FULL,
      },
    });
    shimmerIds.push(`${fillSrc}-extrusion`);
  } else {
    // Pending: flat, low-opacity fill + dashed outline. No extrusion, no
    // per-run colour — deliberately reads as "not confirmed" rather than as
    // a 7th entry in the fence-colour rotation.
    map.addLayer({
      id: `${fillSrc}-fill`,
      type: 'fill',
      source: fillSrc,
      slot: MAP_SLOT_FILL,
      paint: { 'fill-color': color, 'fill-opacity': PENDING_FILL_OPACITY },
    });
    map.addLayer({
      id: `${fillSrc}-dash`,
      type: 'line',
      source: fillSrc,
      slot: MAP_SLOT_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-opacity': PENDING_LINE_OPACITY,
        'line-width': 2,
        'line-dasharray': [2, 2],
      },
    });
  }

  map.on('click', `${fillSrc}-${f.kind === 'saved' ? 'extrusion' : 'fill'}`, (e: MapMouseEvent) => {
    const feature = e.features?.[0];
    const id = feature?.properties?.id as string | undefined;
    const kind = feature?.properties?.kind as 'saved' | 'pending' | undefined;
    if (id && kind) onSelect(id, kind);
  });

  // The RIM — the territory's own boundary, carrying the flowing gradient
  // once around itself. This is the saved-map twin of the live Track map's
  // FILL_OUTLINE_SRC (constants/map.ts's LIVE_FILL_OUTLINE_WIDTH), and it is
  // what makes "loops around each saved territory" literal: the fill keeps
  // the run's own identity colour (needed to tell territories apart when
  // several are on screen at once), so only the edge carries the shared
  // iridescent ramp.
  //
  // One Feature per outer ring in one source, rather than a MultiLineString:
  // `line-progress` is computed per feature, so each lobe of a MultiPolygon
  // territory gets its own complete loop instead of sharing one ramp
  // stretched across all of them.
  if (f.kind === 'saved') {
    map.addSource(rimSrc, {
      type: 'geojson',
      lineMetrics: true,
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: rimSrc,
      type: 'line',
      source: rimSrc,
      slot: MAP_SLOT_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': LIVE_FILL_OUTLINE_WIDTH,
        'line-color': ROUTE_GRADIENT[0][1], // fallback — see the route layer below
        'line-gradient': lineGradientExpression(),
        'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
      },
    });
    flowIds.push(rimSrc);
    stageLineData(map, rimSrc, {
      type: 'FeatureCollection',
      features: outerRings(f.geometry).map(
        (ring): Feature => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: ring },
        }),
      ),
    });
  }

  // The route — saved gets the full vibrant gradient (fence-map.web.tsx's
  // technique, one feature per source so line-progress is well-defined);
  // pending gets nothing extra beyond the dashed outline above, since a
  // route that hasn't even finished uploading reads as more confirmed than
  // it should if it were drawn with the same vibrant treatment as a real one.
  if (f.kind === 'saved' && f.route && f.route.length >= 2) {
    map.addSource(routeSrc, {
      type: 'geojson',
      lineMetrics: true,
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: routeSrc,
      type: 'line',
      source: routeSrc,
      slot: MAP_SLOT_ROUTE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ROUTE_LINE_WIDTH,
        // Fallback for if line-gradient is ever rejected — Mapbox's default
        // line-color is #000000, so without this a rejected gradient renders
        // as a deliberate-looking black line instead of failing loudly.
        'line-color': ROUTE_GRADIENT[0][1],
        'line-gradient': lineGradientExpression(),
        'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
      },
    });
    flowIds.push(routeSrc);
    stageLineData(map, routeSrc, {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: f.route.map(({ lng, lat }) => [lng, lat]) },
    });
  }

  return { flowIds, shimmerIds };
}

/**
 * Fills a gradient line source on the NEXT frame instead of baking the data
 * straight into addSource(). Not ceremony: fence-map.web.tsx hit a layer
 * that rendered pure black — line-gradient's silent fallback — with
 * lineMetrics:true and a valid expression already set, and going through
 * setData() after an empty source is the one thing proven to make GL JS
 * compute line-progress for it (P3 §7c). Both gradient layers here were
 * baking their data in directly, the shape that failed there.
 *
 * The layer can be removed before the frame lands (a delete, or a pending
 * run promoted to saved mid-flight), so this re-checks the source exists.
 */
function stageLineData(map: MapboxMap, srcId: string, data: Feature | FeatureCollection) {
  requestAnimationFrame(() => {
    (map.getSource(srcId) as GeoJSONSource | undefined)?.setData(data);
  });
}

function removeFeatureLayers(map: MapboxMap, key: string) {
  const fillSrc = `terr-fill-${key}`;
  const routeSrc = `terr-route-${key}`;
  const rimSrc = `terr-rim-${key}`;
  for (const id of [`${fillSrc}-extrusion`, `${fillSrc}-fill`, `${fillSrc}-dash`, routeSrc, rimSrc]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const src of [fillSrc, routeSrc, rimSrc]) {
    if (map.getSource(src)) map.removeSource(src);
  }
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
});
