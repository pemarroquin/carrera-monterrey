// Board 2's screen half: the areas in a region, and who is Legend of each.
//
// Lives inside the Leaderboard tab rather than getting its own, which is the
// standing rule in this project — check for reusable space before adding nav
// surface. It IS a different board (Board 1 is "who holds the most ground
// right now", this is "who shows up"), so it sits behind a mode toggle
// rather than being mixed into the same list, where two incomparable numbers
// would look like one ranking.
//
// Legends are fetched PER AREA, on tap, not for every area up front. A list
// of N areas would otherwise cost N round trips on mount to render numbers
// nobody has looked at yet.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { LEGEND_WINDOW_DAYS, fetchAreas, fetchLegends, type Area, type LegendRow } from '@/lib/areas';
import { useI18n } from '@/lib/i18n';
import type { ThemeColor } from '@/constants/theme';
import { Spacing } from '@/constants/theme';

type AreasState = { ok: true; areas: Area[] } | { ok: false } | null;

export function LegendsBoard({
  regionId,
  c,
  meUserId,
}: {
  regionId: string | null;
  c: Record<ThemeColor, string>;
  meUserId: string | null;
}) {
  const { t } = useI18n();
  const [areas, setAreas] = useState<AreasState>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [legends, setLegends] = useState<Record<string, LegendRow[] | 'loading' | 'failed'>>({});

  useEffect(() => {
    let stale = false;
    // Deferred a tick, never called straight from the effect body — the same
    // React Compiler rule the rest of this codebase follows.
    const id = setTimeout(() => {
      fetchAreas(regionId).then((outcome) => {
        if (stale) return;
        setAreas(outcome.ok ? { ok: true, areas: outcome.areas } : { ok: false });
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [regionId]);

  const toggle = useCallback(
    (area: Area) => {
      if (openId === area.id) {
        setOpenId(null);
        return;
      }
      setOpenId(area.id);
      // Cached after the first open: the window is 30 days, so the answer
      // does not change while someone is looking at it.
      if (legends[area.id] !== undefined && legends[area.id] !== 'failed') return;
      setLegends((prev) => ({ ...prev, [area.id]: 'loading' }));
      void fetchLegends(area.id).then((outcome) => {
        setLegends((prev) => ({
          ...prev,
          [area.id]: outcome.ok ? outcome.legends : 'failed',
        }));
      });
    },
    [openId, legends],
  );

  if (areas === null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    );
  }
  if (!areas.ok) {
    return <Text style={[styles.note, { color: c.textSecondary }]}>{t('leaderboard.error')}</Text>;
  }
  if (areas.areas.length === 0) {
    return <Text style={[styles.note, { color: c.textSecondary }]}>{t('leaderboard.areasEmpty')}</Text>;
  }

  return (
    <View style={styles.list}>
      <Text style={[styles.explainer, { color: c.textSecondary }]}>
        {t('leaderboard.legendsExplainer', { days: LEGEND_WINDOW_DAYS })}
      </Text>

      {areas.areas.map((area) => {
        const rows = legends[area.id];
        const open = openId === area.id;
        return (
          <View key={area.id} style={[styles.card, { backgroundColor: c.backgroundElement }]}>
            <Pressable
              onPress={() => toggle(area)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              style={styles.cardHead}>
              <Text style={[styles.areaName, { color: c.text }]}>{area.name}</Text>
              <Text style={[styles.areaSize, { color: c.textSecondary }]}>
                {t('leaderboard.areaTiles', { count: area.cellCount })}
              </Text>
            </Pressable>

            {open && rows === 'loading' && <ActivityIndicator color={c.textSecondary} />}
            {open && rows === 'failed' && (
              <Text style={[styles.note, { color: c.textSecondary }]}>{t('leaderboard.error')}</Text>
            )}
            {open && Array.isArray(rows) && rows.length === 0 && (
              <Text style={[styles.note, { color: c.textSecondary }]}>{t('leaderboard.legendsEmpty')}</Text>
            )}
            {open &&
              Array.isArray(rows) &&
              rows.map((row, i) => {
                const isMe = meUserId !== null && row.userId === meUserId;
                return (
                  <View key={row.userId} style={styles.row}>
                    <Text style={[styles.rank, { color: c.textSecondary }]}>{i + 1}</Text>
                    <Text
                      style={[styles.rowName, { color: isMe ? c.accent : c.text }]}
                      numberOfLines={1}>
                      {row.displayName ?? t('leaderboard.anonymous')}
                    </Text>
                    {/* DAYS, not distance or tiles — the whole point of this
                        board. Labelled so it can never be read as either. */}
                    <Text style={[styles.days, { color: c.textSecondary }]}>
                      {t('leaderboard.legendDays', { count: row.days })}
                    </Text>
                  </View>
                );
              })}
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
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: Spacing.two },
  areaName: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  areaSize: { fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rank: { fontSize: 13, fontWeight: '700', minWidth: 18 },
  rowName: { fontSize: 15, flex: 1 },
  days: { fontSize: 13, fontWeight: '600' },
  note: { fontSize: 13, lineHeight: 18, padding: Spacing.three },
  centre: { padding: Spacing.five, alignItems: 'center' },
});
