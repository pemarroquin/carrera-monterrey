// Who holds this district, drawn — NATIVE.
//
// react-native-maps rather than GL JS, for the same hard reason the Track and
// Fence maps split: the Static Images API cannot render Mapbox Standard
// styles and this platform has no GL JS. See track-map.web.tsx's header.
//
// One dissolved shape per OWNER, not one polygon per hexagon — see
// district-map.web.tsx for why that matters at enclosure scale (~26,000 cells
// for a 10 km loop). Holes are dropped: react-native-maps takes an outer ring
// plus a separate `holes` prop, and an enclosed region inside someone's
// territory is still their ground, so there is nothing to cut out. Same
// decision, same reasoning, as track-map.tsx's tile fill.
import { cellToBoundary, cellsToMultiPolygon } from 'h3-js';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Polygon, Polyline } from 'react-native-maps';

import type { DistrictHolding, DistrictMapProps } from '@/components/district-map.web';

export type { DistrictHolding, DistrictMapProps };

/** Padding on the district's own bounds, as a fraction of its span. The
 *  district IS the frame — a little air keeps its dashed edge off the corners
 *  of the card. */
const FRAME_PAD = 0.12;

export function DistrictMap({ district, holdings }: DistrictMapProps) {
  const outline = useMemo(
    () =>
      // Default (non-GeoJSON) output is [lat, lng], already
      // react-native-maps' order once mapped.
      cellToBoundary(district).map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
    [district],
  );

  const region = useMemo(() => {
    const lats = outline.map((p) => p.latitude);
    const lngs = outline.map((p) => p.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: (maxLat - minLat) * (1 + FRAME_PAD * 2),
      longitudeDelta: (maxLng - minLng) * (1 + FRAME_PAD * 2),
    };
  }, [outline]);

  const shapes = useMemo(
    () =>
      holdings.flatMap((holding) => {
        if (holding.cells.length === 0) return [];
        // Guarded for the same reason the web map guards: cellsToMultiPolygon
        // throws on a malformed cell, and one bad id must not take the board
        // down. A missing runner beats a blank card.
        let rings: number[][][][];
        try {
          rings = cellsToMultiPolygon(holding.cells);
        } catch {
          return [];
        }
        return rings.map((ring, i) => ({
          key: `${holding.userId}-${i}`,
          color: holding.color,
          isMe: holding.isMe,
          coords: (ring[0] as unknown as [number, number][]).map(([lat, lng]) => ({
            latitude: lat,
            longitude: lng,
          })),
        }));
      }),
    [holdings],
  );

  return (
    <View style={styles.wrap}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        // Literal "dark", matching track-map.tsx and fence-map.tsx — the prop
        // takes a style name, not the MAP_ALWAYS_DARK boolean.
        userInterfaceStyle="dark"
        // A summary, not a surface to explore — panning off the district
        // would show ground this board says nothing about. The Track map is
        // where a runner navigates.
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}>
        {shapes.map((shape) => (
          <Polygon
            key={shape.key}
            coordinates={shape.coords}
            // Your own ground reads stronger than everyone else's, matching
            // the ring on your row and your slice of the share bar.
            fillColor={`${shape.color}${shape.isMe ? '8C' : '4D'}`}
            strokeColor={shape.color}
            strokeWidth={1}
          />
        ))}
        <Polyline
          coordinates={[...outline, outline[0]]}
          strokeColor="rgba(255,255,255,0.35)"
          strokeWidth={1.5}
        />
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 220, borderRadius: 16, overflow: 'hidden' },
});
