// Settings › Where you've run — the permanent personal record.
//
// The counterpart to the live map, and deliberately a different surface.
// Under CONQUEST the map and the leaderboard show ground you hold RIGHT NOW,
// which can fall while you sleep. That is the game. But it means the map
// stopped being a record, and "I have run every street in this
// neighbourhood" is worth keeping — so it moved here, where nobody can take
// it.
//
// It is also where a run that could not claim territory still shows up: a
// session uploaded past the claim window saves normally and appears on this
// map, just not on the board. See claim_run_tiles' window.
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { cellsToMultiPolygon } from 'h3-js';
import type { MultiPolygon } from 'geojson';

import { SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { TerritoriesMap, type TerritoryFeature } from '@/components/territories-map';
import { useI18n } from '@/lib/i18n';
import { fetchMyVisitedCells } from '@/lib/territory-sync';

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; cells: string[] };

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
        setState(outcome.ok ? { status: 'ready', cells: outcome.cells } : { status: 'error' });
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

  if (state.cells.length === 0) {
    return (
      <SettingsPage>
        <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>{t('settings.historyEmpty')}</Text>
      </SettingsPage>
    );
  }

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
    coordinates: cellsToMultiPolygon(state.cells, true),
  };
  const features: TerritoryFeature[] = [
    { id: 'history', kind: 'saved', geometry, route: null, startedAtMs: 0 },
  ];

  return (
    <SettingsPage>
      <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>
        {t('settings.historyHint', { count: state.cells.length })}
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
