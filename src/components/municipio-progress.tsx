// Park-path progress, per municipio — the Saved tab's third view.
//
// Pedro's ask: navigate the municipios of the state and see "my progress" in
// each. The unit is what took work to settle. Measured on real data, one
// 5.7 km run in San Pedro Garza García is 0.262% of the municipio's AREA,
// 0.63% of its whole street network, and 5.5% of its PARK PATHS. Only the
// last is a bar that moves; the others are years or never — and a
// denominator nobody can approach is not a goal, it is a reminder that you
// are nothing.
//
// Wandrer and CityStrides each landed on streets rather than area
// independently, for the same reason: area includes buildings, private land
// and water, so 100% is unreachable by construction. Park paths are the
// version of that which fits a running app in a city.
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Spacing, type ThemeColor } from '@/constants/theme';
import { fetchMunicipioProgress, type MunicipioProgress } from '@/lib/progress';
import { useI18n } from '@/lib/i18n';

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: MunicipioProgress[] };

export function MunicipioProgressList({ c }: { c: Record<ThemeColor, string> }) {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let stale = false;
    // Deferred a tick, never from the effect body — the React Compiler rule
    // every other fetch effect in this app follows.
    const id = setTimeout(() => {
      fetchMunicipioProgress().then((outcome) => {
        if (stale) return;
        setState(outcome.ok ? { status: 'ready', rows: outcome.municipios } : { status: 'error' });
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    );
  }
  if (state.status === 'error') {
    return <Text style={[styles.note, { color: c.textSecondary }]}>{t('myraces.progressFailed')}</Text>;
  }
  if (state.rows.length === 0) {
    // No park data loaded for any municipio yet. Distinct from "you have run
    // nowhere" — saying "0%" here would blame the runner for missing
    // reference data.
    return <Text style={[styles.note, { color: c.textSecondary }]}>{t('myraces.progressEmpty')}</Text>;
  }

  return (
    <View style={styles.list}>
      <Text style={[styles.explainer, { color: c.textSecondary }]}>{t('myraces.progressExplainer')}</Text>
      {state.rows.map((m) => {
        const pct = m.total > 0 ? (m.covered / m.total) * 100 : 0;
        return (
          <View key={m.municipio} style={[styles.card, { backgroundColor: c.backgroundElement }]}>
            <View style={styles.head}>
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                {m.municipio}
              </Text>
              {/* Two decimals below 1%: at these denominators a single run is
                  a fraction of a percent, and "0%" next to a run the runner
                  remembers doing reads as broken. */}
              <Text style={[styles.pct, { color: m.covered > 0 ? c.accent : c.textSecondary }]}>
                {pct >= 1 ? pct.toFixed(1) : pct.toFixed(2)}%
              </Text>
            </View>
            {/* The bar is the point — a number this small only means
                something next to the whole it is part of. */}
            <View style={[styles.track, { backgroundColor: c.background }]}>
              <View
                style={[
                  styles.fill,
                  // A covered-but-tiny sliver still renders: territory the
                  // runner really has must never look like none.
                  { width: `${m.covered > 0 ? Math.max(pct, 1.5) : 0}%`, backgroundColor: c.accent },
                ]}
              />
            </View>
            <Text style={[styles.detail, { color: c.textSecondary }]}>
              {t('myraces.progressDetail', {
                covered: m.covered,
                total: m.total,
                km: m.pathKm.toFixed(0),
                parks: m.parks,
              })}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.three, gap: Spacing.two },
  explainer: { fontSize: 13, lineHeight: 18, paddingBottom: Spacing.one },
  card: { borderRadius: Spacing.three, padding: Spacing.three, gap: Spacing.two },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: Spacing.two },
  name: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  pct: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  detail: { fontSize: 12, lineHeight: 17 },
  note: { fontSize: 13, lineHeight: 18, padding: Spacing.three },
  centre: { padding: Spacing.five, alignItems: 'center' },
});
