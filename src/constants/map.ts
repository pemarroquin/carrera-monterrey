// Map styling for Territory Mode.
//
// There are TWO style ids here and they are not interchangeable, because the
// two rendering paths accept different kinds of style:
//
// - Mapbox GL JS (web) renders **Mapbox Standard** styles — the new
//   `imports`-based architecture Studio creates by default. That's what
//   MAP_STYLE_GL is.
// - The Static Images API (native, where Expo Go can't load a GL SDK) does
//   NOT render Standard styles. It returns a blank image rather than an
//   error — verified 2026-08-26: the custom style and `mapbox/standard`
//   both came back essentially empty (5KB / 85B) while `mapbox/dark-v11`
//   returned a real 27KB map. So native falls back to a stock classic dark
//   style that looks close.
//
// If the two ever need to match exactly, the fix is to rebuild the custom
// style from a *classic* template in Studio (not Standard) and point both
// constants at it.

/**
 * Tile Coverage Model rendering (brief §5/§6 step 4). Own claimed tiles
 * render at this opacity in the run's own colour, on both platforms —
 * chosen to sit close to LIVE_FILL_OPACITY_HIGH/FENCE_FILL_OPACITY's own
 * "vibrant but not opaque" range rather than a fresh guess. Rival-owned
 * tiles get their own, more muted constant so contested ground reads at a
 * glance without needing a legend (brief §5).
 */
export const TILE_FILL_OPACITY = 0.35;
export const TILE_RIVAL_FILL_OPACITY = 0.14;
/** Rival tiles' flat neutral colour — deliberately NOT any FENCE_COLOR_SETS
 *  entry (those are all reserved for identifying a specific run/owner);
 *  "someone else's, unspecified" needs a colour that never collides with
 *  an actual owner's. */
export const TILE_RIVAL_COLOR = '#9AA5B1';

/** Custom Studio style — Mapbox Standard, GL JS only (web). */
export const MAP_STYLE_GL = 'mapbox://styles/pmarroquin/cmtapbd8m00zi01qjhx0jbmuh';

/** Classic style for the Static Images API (native). `{owner}/{style}` form. */
export const MAP_STYLE_STATIC = 'mapbox/dark-v11';

/**
 * The map is dark regardless of the app's light/dark setting, deliberately:
 * it's a full-bleed game surface, and the route line and territory fill are
 * tuned for contrast against a dark ground.
 */
export const MAP_ALWAYS_DARK = true;

/**
 * Shared zoom for the Track tab's idle/centred view, both platforms. Was 16
 * on web (track-map.web.tsx) and 15 on native (buildPinMapUrl) — two
 * slightly different hand-picked values for what is visually the same
 * "before you start running" shot, unified here.
 *
 * First dropped 4 levels to 12 (2026-08-26), then walked back — 12 read as
 * zoomed too far out, closer to a city-district view than the neighbourhood
 * shot Google Maps opens to by default (its own default is commonly z15-16:
 * street names legible, a handful of blocks visible, not yet building
 * outlines). Settled at 15 for the same reason. Mapbox Standard (the style
 * this app uses on web, see MAP_STYLE_GL) scales its label text size to
 * zoom automatically as part of the style itself — that's one of Standard's
 * differences from classic styles — so labels shouldn't read as
 * disproportionate at this level the way a fixed-size label layer might.
 */
export const MAP_DEFAULT_ZOOM = 15;

/** Route line. Hex with '#', for GL JS and SVG. */
export const ROUTE_LINE_COLOR = '#E4572E';
/** Same colour without '#', for Static Images URL overlays. */
export const ROUTE_LINE_COLOR_URL = 'e4572e';
/**
 * Halved 2026-09-08 (5 -> 2.5), Pedro's call: the gradient line read as too
 * heavy on every surface that draws it. The glow below is halved with it so
 * the proportion between line and halo is unchanged — the style is the same,
 * just finer.
 *
 * ONE constant for every surface: the live edge (track-map), the run summary
 * (fence-map) and saved territories (territories-map) all read it, which is
 * what keeps a route looking like the same route wherever it appears.
 */
export const ROUTE_LINE_WIDTH = 2.5;
/** Wider, blurred copy under the main line — reads as a glow on dark ground. */
export const ROUTE_GLOW_WIDTH = 7;
export const ROUTE_GLOW_BLUR = 3;
export const ROUTE_GLOW_OPACITY = 0.35;

/**
 * Fill opacity for buildFenceMapUrl's static-image overlay (mapbox.ts) —
 * the Saved > Territories list thumbnails (myraces.tsx). Was 0.25, which
 * read as muddy/near-invisible against the classic dark-v11 style's near-
 * black ground (reported by Pedro, 2026-08-31, from a real device
 * screenshot). No emissive-strength or slot tuning applies here the way it
 * does to MAP_STYLE_GL's Standard layers — the Static Images API is a flat
 * pre-rendered image, plain alpha compositing, no scene lighting to
 * correct for. Opacity is the only lever, so it has to carry the whole
 * "vibrant" ask alone; bumped to actually read as one on a dark ground.
 */
export const FENCE_FILL_OPACITY = 0.45;

/**
 * Full intensity for EVERY custom line/fill/fill-extrusion layer added to
 * MAP_STYLE_GL (GL JS only — the Static Images API's classic dark-v11 style
 * has no such concept and needs none). Mapbox Standard shades custom layers
 * by the style's light preset exactly like its own basemap layers; this
 * Studio style sets `lightPreset: 'night'` on its Standard import (confirmed
 * via the Styles API, 2026-08-31), which is why every route/fence/wall
 * colour rendered at roughly a third of its intended brightness — muddy,
 * near-black, no contrast against the dark ground. Setting a layer's
 * `*-emissive-strength` to this value makes it emit its own colour at full
 * intensity regardless of scene lighting. Reported by Pedro three times
 * before being traced to this.
 */
export const EMISSIVE_STRENGTH_FULL = 1;

/**
 * Named slot positions in Mapbox Standard's layer order — this style's
 * `basemap` import (mapbox://styles/mapbox/standard) defines exactly these
 * three: https://docs.mapbox.com/map-styles/guides/standard-styles/. A
 * layer added with no `slot` renders wherever Standard's own composite step
 * happens to place it relative to roads/labels/buildings — a second,
 * independent way to look buried or to bury the basemap, on top of the
 * emissive-strength issue above.
 *
 * - 'top': above POI layers, below only Place/Transit labels. Every route
 *   line and outline uses this — a route must never render underneath a
 *   road or building.
 * - 'middle': above paths/roads, below buildings and every label. Every
 *   fill/fill-extrusion uses this — a translucent territory fill is
 *   SUPPOSED to shade the streets under it (that is the point of a fill),
 *   while road and place names stay legible on top of it.
 */
export const MAP_SLOT_ROUTE = 'top';
export const MAP_SLOT_FILL = 'middle';

/**
 * How often the live territory fill (buildFence() over the growing route)
 * is recomputed while running, whichever trips first — see
 * track-map.web.tsx. turf's clean/simplify/union pipeline is O(n) on a ring
 * that only grows; recomputing it on every 2s fix would redo that work for
 * the length of a 30+ minute run. buildFence itself is cheap to call when
 * there's nothing new to give it, so the throttle lives at the call site,
 * not inside territory.ts.
 */
export const LIVE_FILL_RECOMPUTE_MS = 5000;
export const LIVE_FILL_RECOMPUTE_POINTS = 10;

/**
 * Live territory fill opacity (GL, web only) — deliberately its OWN
 * constants, not FENCE_FILL_OPACITY, which is tuned for the Static Images
 * API's classic dark-v11 style (no light preset, no emissive-strength,
 * always fully lit). Once EMISSIVE_STRENGTH_FULL corrects the raw fill
 * colour, it reads far more vivid than the same colour did muddied by the
 * night preset — these read as vibrant but subtle against the corrected
 * colour, rather than needing the higher number that was really
 * compensating for the colour being washed out.
 *
 * Two values, not one: the fill BREATHES between them while a session is
 * live (see track-map.web.tsx's pulse effect) rather than sitting at a flat
 * opacity — Pedro's ask was for something animated and alive, not a static
 * colour wash. Each `setPaintProperty` call is cheap (fires once per
 * LIVE_FILL_PULSE_MS, not every frame); `fill-opacity-transition`, set once
 * when the layer is created, is what makes the GPU interpolate smoothly
 * between the two values in between calls — the same trick already used for
 * the wall's rise and the summary fence's fade-in, NOT a
 * requestAnimationFrame loop repainting the whole map every frame for the
 * length of a run (see the "you are here" pulse dot's own comment for why
 * that specific trap matters here).
 */
export const LIVE_FILL_OPACITY_LOW = 0.14;
export const LIVE_FILL_OPACITY_HIGH = 0.3;
/** One full breathe (low → high → low) takes roughly 2x this, since each
 *  call flips to the opposite value. */
export const LIVE_FILL_PULSE_MS = 2600;

/**
 * Chromatic rim traced around the live fill's growing boundary — the same
 * `line-gradient` technique as the route line and the summary outline
 * (ROUTE_GRADIENT), applied to the territory's EDGE instead of the path.
 * This is the closest a flat 2D map layer gets to a rim-lit glow: the fill
 * itself stays each run's own identity colour (FENCE_COLOR_SETS — needed to
 * tell territories apart when several are shown together), so only the
 * outline carries the shared iridescent gradient.
 */
export const LIVE_FILL_OUTLINE_WIDTH = 2.5;

/**
 * Saved territories cycle their fill through the full ROUTE_GRADIENT hue
 * wheel instead of sitting on one flat colour — Pedro's ask, 2026-09-08:
 * "gradient vibrant and colourful like the Apple shimmer, with the smooth
 * animation".
 *
 * Done in TIME rather than in space, and that is a real constraint rather
 * than a shortcut: Mapbox GL has no positional gradient for fills. Only
 * LINES take one (`line-gradient` over line-progress), which is why the
 * territory OUTLINE already carries the spatial gradient — see
 * LIVE_FILL_OUTLINE_WIDTH's comment. A fill can only be given a pattern
 * image, which tiles visibly on an extrusion. So the fill sweeps the same
 * wheel over time while the edge holds it across space, and together they
 * read as one shimmering surface.
 *
 * The smoothness is the GPU's, not a render loop's:
 * `fill-extrusion-color-transition` is set to this same duration, so GL
 * interpolates between each pair of stops. Same technique as the live map's
 * opacity breathe (LIVE_FILL_PULSE_MS), for the same reason — a rAF loop
 * repainting a map layer 60 times a second is a battery cost mid-run.
 */
export const FENCE_SHIMMER_STEP_MS = 2200;


/**
 * The route/territory gradient — a full 12-colour HUE WHEEL, in order, each
 * roughly 30 degrees from its neighbours. It is a WHEEL and not a ramp:
 * entry 11 sits next to entry 0 in hue, so the list closes on itself and
 * anything that loops (a territory's boundary, a gradient flowing along a
 * line forever) can traverse it endlessly with no seam. That property is
 * load-bearing — see cyclicGradientColorAt in fence-draw.ts for what the
 * alternatives cost.
 *
 * Grown from 6 to 12 on Pedro's ask (2026-09-04) for "more vibrant and
 * colorful". Six colours only reached from indigo to gold, a bit over half
 * the wheel; closing it needed a return leg through greens and teals, which
 * is what took it to twelve. Those additions are not new to the app — lime,
 * cyan, blue and amber are lifted straight from FENCE_COLOR_SETS, which has
 * always been a full-spectrum palette. The originals are all still here, in
 * their original order.
 *
 * Kept vivid on purpose: every entry's max-minus-min channel spread stays
 * high, and so does every blend BETWEEN two of them (asserted in
 * map.test.ts). A dull colour anywhere in the wheel would circulate through
 * every animated line on the map forever — which is why the original ramp's
 * gold (#FEDA75) is the one of the six not carried over verbatim. Rendered
 * beside eleven fully saturated neighbours it read as a pale, washed-out
 * band; FENCE_COLOR_SETS' own amber is the same hue with the saturation the
 * rest of the wheel has.
 */
export const ROUTE_GRADIENT_COLORS: string[] = [
  '#4F5BD5', // indigo
  '#8A2BE2', // violet
  '#C13BE8', // orchid
  '#ED2FA0', // magenta
  '#F4508B', // pink
  '#FF4B3E', // vermilion
  '#FA7E1E', // orange
  '#FBBF24', // amber
  '#A3E635', // lime
  '#2FD98A', // emerald
  '#22D3EE', // cyan
  '#3B82F6', // blue
];

/**
 * The same wheel laid out ONCE across a line, as `line-gradient` stops
 * (offset 0-1). This is the static form: the fallback a layer is created
 * with before any flow starts, and what native samples per-vertex
 * (gradientStrokeColors) since react-native-maps cannot animate a Polyline's
 * colours without re-rendering it.
 *
 * The closing stop repeats entry 0, so laying the whole wheel out end to end
 * leaves both ends of the line on the same colour. That gives up the old
 * 6-colour ramp's cool-tail/warm-head cue — but that cue only ever survived
 * on a line that WASN'T animating, and every web surface that draws this now
 * flows it (gradient-flow.ts), which moves every colour past every point on
 * the line anyway.
 *
 * `line-gradient` requires `lineMetrics: true` on the GeoJSON source — the
 * property is silently ignored without it, which looks like a flat line
 * rather than an error.
 */
export const ROUTE_GRADIENT: [number, string][] = [
  ...ROUTE_GRADIENT_COLORS.map((color, i): [number, string] => [
    i / ROUTE_GRADIENT_COLORS.length,
    color,
  ]),
  [1, ROUTE_GRADIENT_COLORS[0]],
];

/**
 * One full trip of the wheel around the line — the loop's period. Slower
 * than the 2.7s the old stepped rotation ran at, for two reasons: an ambient
 * "still alive" motion reads better calm than urgent, and a slower loop is
 * what lets the tick cadence below stay modest while each frame still moves
 * the pattern only a few pixels. Deliberately NOT a neat multiple of
 * LIVE_FILL_PULSE_MS — the fill's breathe and this flow drift in and out of
 * phase instead of pulsing in lockstep, which reads as two independent
 * living things rather than one metronome.
 */
export const ROUTE_GRADIENT_LOOP_MS = 4400;

/**
 * Tick cadence for that loop. `line-gradient` is a ColorRampProperty with NO
 * `-transition` support at all (confirmed against the installed mapbox-gl
 * typings — it is neither a DataDrivenProperty nor a DataConstantProperty),
 * so unlike LIVE_FILL_OPACITY's breathe there is no GPU tween between calls:
 * every update lands exactly as drawn.
 *
 * Smoothness therefore has to come from making each update SMALL, not from
 * interpolation. At 60ms against a 4.4s loop the pattern advances 1/73rd of
 * the line per tick — a few pixels, and a colour shift of at most 8% of a
 * channel (measured across a full loop). The previous implementation moved
 * every colour a whole stop along the ramp every 450ms — a jump of up to
 * 40% of a channel, six times per cycle. That is what read as stepped.
 *
 * These two numbers also define the loop's frame TABLE: it repeats exactly
 * every round(LOOP / FRAME) ticks, so gradient-flow.ts precomputes that many
 * expressions once and then only indexes into them. Changing either constant
 * changes the table's size, nothing else.
 *
 * The cost is ~17 setPaintProperty calls/sec per animated layer against the
 * old ~2.2. Still a JS interval, NOT a requestAnimationFrame loop (see
 * track-map.web.tsx's pulse-dot comment) — each tick only queues a single
 * rAF callback to land the paint on the next frame, and each
 * setPaintProperty only marks the layer dirty: GL still repaints once per
 * frame, not once per call.
 */
export const ROUTE_GRADIENT_FRAME_MS = 60;

/** Trailing distance that stays a flat line before the route sets into wall. */
export const FENCE_LAG_M = 100;
/** Wall thickness on the ground, metres (web — the 3D extrusion gets its
 *  visual bulk from height, so the footprint stays thin). */
export const FENCE_WALL_WIDTH_M = 3;
/** Ribbon width on native, metres. The native fence is a FLAT filled ribbon
 *  (react-native-maps has no fill-extrusion), so without the 18m of wall
 *  height it needs a wider footprint to read as a fence at all — 3m is
 *  ~4px at the session zoom. */
export const FENCE_RIBBON_WIDTH_M = 8;
/** Wall height, metres. */
export const FENCE_WALL_HEIGHT_M = 18;
export const FENCE_WALL_OPACITY = 0.55;
/** Default wall colour — only the pre-session layer setup uses this; each
 *  session repaints with its own set (see FENCE_COLOR_SETS below). */
export const FENCE_WALL_COLOR = '#8A2BE2';

/**
 * Fence colour sets — each run's fence gets ONE of these, so territories are
 * tellable apart on a map of many. Pedro's ask (2026-08-27): "a different
 * color each run", from a configurable list — add/remove/reorder sets here
 * freely (a Settings picker can layer on later).
 *
 * Selection is `fenceColorForRun(startedAtMs)`: deterministic from the run's
 * start time, which is already stored in Supabase (`runs.started_at`) — so
 * every screen on every device derives the SAME colour for the same run with
 * no colour column and no migration (those are applied by hand in this
 * project and an unapplied one fails silently).
 */
export interface FenceColorSet {
  id: string;
  /** '#rrggbb'. Fills/strokes derive their alpha from the FENCE_* opacities. */
  color: string;
}

export const FENCE_COLOR_SETS: FenceColorSet[] = [
  { id: 'violet', color: '#8A2BE2' },
  { id: 'cyan', color: '#22D3EE' },
  { id: 'magenta', color: '#EC4899' },
  { id: 'lime', color: '#A3E635' },
  { id: 'amber', color: '#FBBF24' },
  { id: 'blue', color: '#3B82F6' },
];

export function fenceColorForRun(startedAtMs: number): FenceColorSet {
  // Seconds, not ms: ISO timestamps round-trip through Postgres with ms
  // precision but the maths shouldn't depend on it.
  const seconds = Math.abs(Math.floor(startedAtMs / 1000));
  return FENCE_COLOR_SETS[seconds % FENCE_COLOR_SETS.length];
}

/** '#rrggbb' + alpha → 'rgba(...)', for react-native-maps fill/stroke props. */
export function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha})`;
}
/** Seconds the wall takes to rise once a stretch settles. */
export const FENCE_RISE_MS = 900;

/** Camera framing when a session starts — tilted, so the wall reads as 3D. */
export const SESSION_ZOOM = 17.5;
export const SESSION_PITCH = 60;
export const SESSION_FLY_MS = 2200;

/**
 * Camera control during a run (track-map.web.tsx) — sweaty-hands gesture
 * drift permanently changed the framing with no way back (Pedro hit this
 * mid-run: "normal at first, then weird"). No interaction detection and no
 * recenter control existed at all.
 *
 * How long the camera sits wherever a user gesture (drag/pinch) left it
 * before gliding back to (runner position, preferredZoom, SESSION_PITCH).
 * Long enough that a deliberate look-around isn't yanked back mid-glance;
 * short enough that a stray pinch self-heals within a few strides.
 */
export const AUTO_RETURN_IDLE_MS = 5000;
/** Zoom delta per tap of the +/- buttons. */
export const ZOOM_STEP = 1;

/**
 * Camera modes during a session — the re-center control CYCLES between
 * these on each tap (product decision, not a two-tap-then-reset button):
 * 'follow' is the Apple/Google Maps turn-by-turn view (heading-up, tilted,
 * zoomed to the runner's own preference); 'overview' is north-up/flat,
 * fitted to the whole run so far. See src/lib/camera.ts for the pure
 * geometry (bearing, bounds) behind both, and track-map.web.tsx /
 * track-map.tsx for how each platform applies it.
 */
export type CameraMode = 'follow' | 'overview';

/**
 * Minimum distance (metres) an earlier point must be from the latest fix
 * before bearingFromPath() (camera.ts) will derive a heading from it. Below
 * this, two fixes can be 1-2m apart from GPS jitter alone — deriving a
 * bearing from that would swing the camera's heading wildly while the
 * runner is simply standing still. Comfortably above typical fix-to-fix GPS
 * noise, comfortably below a single running stride's worth of distance.
 */
export const MIN_BEARING_SEPARATION_M = 8;

/**
 * Max degrees the follow camera's heading moves per camera update
 * (smoothBearing, camera.ts) — caps how far one jittery fix can swing the
 * bearing, so a real turn reads as a smooth arc rather than the camera
 * snapping. Generous enough that an actual corner (a runner turning onto a
 * cross street) still completes in one or two updates, not a slow crawl.
 */
export const MAX_BEARING_STEP_DEG = 45;

/**
 * Web only (Mapbox GL's `offset` camera option, in pixels, is screen-space
 * and zoom-independent — see track-map.web.tsx). Fraction of the VISIBLE
 * map band's height the follow camera's target is pushed DOWN-screen, so
 * the runner sits toward the lower third of what they can actually see and
 * more map shows ahead of them than behind — the Apple/Google Maps
 * turn-by-turn framing Pedro asked to match.
 *
 * Changed 2026-09-07 (0.28 of the CONTAINER -> 0.167 of the visible band)
 * after the route was reported sitting lower on screen than it should.
 * Both halves of that were wrong:
 *
 *  - 0.28 below the centre is 78% of the way down — the lower QUARTER, not
 *    the "lower third" this comment claimed. 1/6 of a height below its
 *    centre is exactly two thirds of the way down it.
 *  - Measured against the raw container it ignored the chrome drawn over
 *    the map: the live stats block up top and the floating tab bar at the
 *    bottom. See camera.ts's followOffsetPx and visibleBand.
 *
 * This is the knob for that framing: raise it to sit lower with more road
 * ahead, drop it to 0 to sit dead-centre in the visible band.
 */
export const FOLLOW_OFFSET_RATIO = 0.167;

/**
 * Native only (track-map.tsx). react-native-maps has no pixel-offset camera
 * option the way Mapbox GL's `offset` does, so the same "more map ahead"
 * framing is done in world-space instead: the follow camera centers on a
 * point this many metres AHEAD of the runner along their heading
 * (destinationPoint, camera.ts), not on the runner's own coordinate. Chosen
 * to read similarly to FOLLOW_OFFSET_RATIO at SESSION_ZOOM's ground scale —
 * both are a "look a bit further up the road" framing, just implemented on
 * whichever axis each platform's camera API actually exposes.
 */
export const FOLLOW_LOOKAHEAD_M = 25;

/**
 * Padding (px) around the fitted bounds in overview mode (fitBounds on web,
 * fitToCoordinates's edgePadding on native) — without this the route runs
 * flush to the viewport edge, which reads as clipped rather than framed.
 */
export const OVERVIEW_FIT_PADDING_PX = 56;

/**
 * Night styling for react-native-maps on Android (Google provider). The
 * native Track map (track-map.tsx) honours MAP_ALWAYS_DARK with this on
 * Android and `userInterfaceStyle="dark"` on iOS — Google ignores that prop
 * and Apple ignores this one, so both are always passed. Google's standard
 * night-mode recipe, trimmed to the layers this map shows.
 */
export const GOOGLE_DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#212121' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#757575' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#181818' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#373737' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3c3c3c' }] },
  { featureType: 'transit', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000000' }] },
];
