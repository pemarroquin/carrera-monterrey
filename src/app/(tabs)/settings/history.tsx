// Settings › the permanent personal record of ground taken.
//
// The counterpart to the live map, and deliberately a different surface.
// Under CONQUEST the map and the leaderboard show ground you hold RIGHT NOW,
// which can fall while you sleep. That is the game. But it means the map
// stopped being a record, and "I took every street in this neighbourhood" is
// worth keeping — so it lives here, where nobody can take it.
//
// It draws ground by THE SAME RULE A RUN DOES: cells crossed, plus the
// interior of any loop a single session closed. Purely informative — nothing
// on this screen is scored, ranked or claimable.
//
// It is also where a run that could not claim territory still shows up: a
// session uploaded past the claim window saves normally and appears on this
// map, just not on the board. See claim_run_tiles' window.
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { cellsToMultiPolygon } from 'h3-js';
import type { MultiPolygon } from 'geojson';

import { SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { enclosedCells, noiseHoles } from '@/lib/enclosure';
import { DEFAULT_TILE_RES } from '@/lib/tiles';
import { TerritoriesMap, type TerritoryFeature } from '@/components/territories-map';
import { useI18n } from '@/lib/i18n';
import { fetchMyVisitedCells } from '@/lib/territory-sync';

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; runs: string[][] };

export default function HistoryScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let stale = false;
    // Deferred a tick, never called from the effect body — same React
    // Compiler rule as every other fetch effect here.
    const id = setTimeout(() => {
      fetchMyVisitedCells().then((outcome) => {
        if (stale) return;
        setState(outcome.ok ? { status: 'ready', runs: outcome.runs } : { status: 'error' });
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <SettingsPage>
        <View style={styles.centre}>
          <ActivityIndicator color={c.textSecondary} />
        </View>
      </SettingsPage>
    );
  }

  if (state.status === 'error') {
    return (
      <SettingsPage>
        <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>{t('settings.historyFailed')}</Text>
      </SettingsPage>
    );
  }

  if (state.runs.length === 0) {
    return (
      <SettingsPage>
        <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>{t('settings.historyEmpty')}</Text>
      </SettingsPage>
    );
  }

  // Ground is assembled by the SAME rule a live run uses: cells crossed,
  // plus the interior of any loop THAT SINGLE SESSION closed.
  //
  // Per run, never across runs. Unioning everything first and enclosing that
  // would let someone run a city's perimeter over six months and claim
  // everything inside — the failure enclosure.ts exists to refuse. Enclosing
  // each run on its own is exactly what the claim path already did to this
  // same ground, so this screen agrees with territory instead of inventing
  // anything.
  //
  // This is what was wrong before 2026-09-09: the screen drew visits ONLY,
  // and so was the one surface in the app applying no enclosure at all. The
  // block around Parque El Capitán came back as a 317-cell black hole on a
  // map whose every other view — including territory_tiles, 100% of it —
  // already counted it as taken.
  //
  // Recomputed here rather than read back from territory_tiles, because
  // territory answers "what do I hold NOW" and conquest takes ground off
  // you. Recomputing from the append-only visit log is what keeps this a
  // permanent record.
  //
  // Privacy: these cells were already privacy-zone-trimmed on the way in
  // (see uploadRun), so enclosure derived from them cannot expose a home
  // loop the mask removed. The trade is that a loop closed only by its
  // masked-off ends does not enclose here even though it did at claim time
  // — the safe direction to be wrong in.
  const ground = [...new Set(state.runs.flatMap((run) => [...run, ...enclosedCells(run, DEFAULT_TILE_RES)]))];

  // Sampling holes are filled after that, at enclosure.ts's measured cap.
  // Still needed: a session that never closed its loop encloses nothing, so
  // a cell the GPS simply missed inside a band run dozens of times is not
  // covered by the rule above. Measured 2026-09-09, per-run enclosure alone
  // already leaves ZERO holes on every real account — this is belt and
  // braces for the runner whose data does not look like theirs.
  const drawn = [...ground, ...noiseHoles(ground, DEFAULT_TILE_RES)];

  // ONE dissolved shape, not one polygon per cell. cellsToMultiPolygon is the
  // same call enclosure.ts and the live maps use, so every surface in the app
  // draws claimed ground the same way — and a history spanning years is far
  // too many hexagons to hand a map individually.
  //
  // Fed to TerritoriesMap as a single feature rather than building a second
  // map component: it already fits bounds, tints, and handles both platforms.
  // `route: null` because this is ground, not a run — there is no single path
  // through a year of running. startedAtMs picks the colour and is arbitrary
  // for one feature.
  const geometry: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: cellsToMultiPolygon(drawn, true),
  };
  const features: TerritoryFeature[] = [
    { id: 'history', kind: 'saved', geometry, route: null, startedAtMs: 0 },
  ];

  return (
    <SettingsPage>
      <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>
        {/* Counts what is DRAWN — ground crossed plus ground enclosed —
            not the raw visit rows. A map showing enclosed ground beside a
            number that excluded it would disagree with itself on the same
            screen. */}
        {t('settings.historyHint', { count: drawn.length })}
      </Text>
      <View style={styles.map}>
        {/* No onSelect target here — a cell is not a run, and there is
            nothing to open. */}
        <TerritoriesMap features={features} onSelect={() => {}} />
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  centre: { padding: 32, alignItems: 'center' },
  // Tall enough to read as a map rather than a strip. The settings page
  // scrolls, so a fixed height is safe.
  map: { height: 420, borderRadius: 12, overflow: 'hidden', marginTop: 8 },
});
