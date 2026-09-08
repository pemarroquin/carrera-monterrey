// Tile Coverage brief §6 step 6 — ranks runners by tiles OWNED (a plain
// `count` over territory_tiles; one tile has exactly one owner at a time,
// though under conquest not forever — see leaderboard.ts's own header),
// with a per-metro board
// and a global one behind a segment. Was area actually held (rankByArea,
// the union-of-fences pipeline) — that function and its ~30 tests are
// UNCHANGED and still exported (brief §4: don't delete), just no longer
// what this screen renders. See leaderboard.ts's own "Tile Coverage Model"
// section header for why the new path is simpler, not just newer.
//
// Regional is the DEFAULT because everything else in this app is
// region-scoped already (the Feed filters by metro, there's a city picker in
// the header): a national board would rank a Monterrey runner against a
// Tijuana one over ground neither can contest. Global is one tap away for
// when the question is "who's biggest anywhere".
import { useIsFocused } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { fenceColorForRun } from '@/constants/map';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { rankByTileCount, type TileLeaderboardEntry } from '@/lib/leaderboard';
import { useRegion } from '@/lib/region-context';
import { LegendsBoard } from '@/components/legends-board';
import { onIdentityChanged } from '@/lib/auth-events';
import { fetchTileLeaderboard, type TileLeaderboardOutcome } from '@/lib/territory-sync';

type Scope = 'region' | 'global';

export default function LeaderboardScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { region } = useRegion();
  const isFocused = useIsFocused();

  const [scope, setScope] = useState<Scope>('region');
  const [data, setData] = useState<TileLeaderboardOutcome | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const outcome = await fetchTileLeaderboard();
    setData(outcome);
  }, []);

  // Refetches on every focus, not just first mount. expo-router tab screens
  // stay mounted rather than remounting per visit, so the old `[]`-deps
  // effect fetched once, early in the session, and never again short of a
  // manual pull-to-refresh. Confirmed live: a user set a new leaderboard
  // display name and saved two real runs — Supabase already had the fresh
  // data server-side (right region, right profile join, right flagged
  // state) while this screen kept showing stale data from the old identity.
  // Deferred by a tick with a `stale` flag on cleanup — same pattern as
  // myraces.tsx's Territories fetch effect.
  // Same reasoning one layer down: the ranking marks "you" by comparing
  // each row against the current session's id, so a sign-in that swaps
  // this device onto another account changes what this screen should
  // render without `isFocused` ever changing. See auth-events.ts.
  // WHICH board. Not a scope of the same ranking — Board 1 counts ground
  // held right now, Board 2 counts days shown up, and the two numbers are
  // not comparable. Behind a toggle rather than mixed into one list, where
  // they would read as a single ranking.
  const [board, setBoard] = useState<'territory' | 'legends'>('territory');
  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);

  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    const id = setTimeout(() => {
      fetchTileLeaderboard().then((outcome) => {
        if (!stale) setData(outcome);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused, identitySignal]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Ranking is recomputed rather than refetched when the scope changes: the
  // count runs over data already in memory, so the toggle is instant — same
  // reasoning as the old rankByArea, cheaper in practice (a count, not a
  // turf union).
  const entries = useMemo<TileLeaderboardEntry[]>(() => {
    if (!data?.ok) return [];
    return rankByTileCount(data.tiles, scope === 'region' ? region.id : null);
  }, [data, scope, region.id]);

  const meUserId = data?.ok ? data.meUserId : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('leaderboard.title')}</Text>
      {/* What this board actually measures. Under first-to-claim the count
          only ever grew, so it needed no explanation; under conquest it can
          FALL while the runner sleeps and someone else runs their streets,
          and a score that drops with no stated reason reads as a bug.
          Only for Board 1 — Board 2 carries its own explainer, since it is
          measuring something else entirely. */}
      {board === 'territory' && (
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>{t('leaderboard.subtitle')}</Text>
      )}

      <View style={styles.segmentRow}>
        {(['territory', 'legends'] as const).map((key) => {
          const selected = board === key;
          return (
            <Pressable
              key={key}
              onPress={() => setBoard(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              aria-checked={selected}
              style={[styles.segment, { backgroundColor: selected ? c.accent : c.backgroundElement }]}>
              <Text style={[styles.segmentLabel, { color: selected ? '#ffffff' : c.textSecondary }]}>
                {t(key === 'territory' ? 'leaderboard.boardTerritory' : 'leaderboard.boardLegends')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Region/global applies to BOTH boards — an area belongs to a region
          the same way a tile does. */}
      <View style={styles.segmentRow}>
        {(['region', 'global'] as const).map((key) => {
          const selected = scope === key;
          return (
            <Pressable
              key={key}
              onPress={() => setScope(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              aria-checked={selected}
              style={[
                styles.segment,
                { backgroundColor: selected ? c.accent : c.backgroundElement },
              ]}>
              <Text
                style={[styles.segmentLabel, { color: selected ? '#ffffff' : c.textSecondary }]}>
                {key === 'region' ? region.name : t('leaderboard.global')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {board === 'legends' ? (
        <ScrollView contentContainerStyle={styles.legendsScroll}>
          <LegendsBoard regionId={scope === 'region' ? region.id : null} c={c} meUserId={meUserId} />
        </ScrollView>
      ) : data === null ? (
        <View style={styles.centre}>
          <ActivityIndicator color={c.textSecondary} />
        </View>
      ) : !data.ok ? (
        <Empty
          icon="exclamationmark.triangle"
          android="warning"
          text={
            data.reason === 'disabled'
              ? t('leaderboard.disabled')
              : t('leaderboard.error')
          }
          c={c}
        />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.userId}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.textSecondary}
            />
          }
          renderItem={({ item, index }) => (
            <Animated.View entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
              <Row
                entry={item}
                rank={index + 1}
                isMe={item.userId === meUserId}
                c={c}
                anonymous={t('leaderboard.anonymous')}
                tilesLabel={t('leaderboard.tiles', { count: item.tileCount })}
                flaggedLabel={t('leaderboard.flaggedTiles', { count: item.flaggedTileCount })}
              />
            </Animated.View>
          )}
          ListEmptyComponent={
            <Empty
              icon="trophy"
              android="trophy"
              text={
                scope === 'region'
                  ? t('leaderboard.emptyRegion', { city: region.name })
                  : t('leaderboard.empty')
              }
              c={c}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

function Row({
  entry,
  rank,
  isMe,
  c,
  anonymous,
  tilesLabel,
  flaggedLabel,
}: {
  entry: TileLeaderboardEntry;
  rank: number;
  isMe: boolean;
  c: Record<string, string>;
  anonymous: string;
  tilesLabel: string;
  flaggedLabel: string;
}) {
  // Colour-coded by the same palette the fences use, keyed on the user id so
  // a runner reads as one colour down the whole board. Not their fence
  // colour (that's per-run, by design) — a per-person accent.
  const tint = fenceColorForRun(hashToSeed(entry.userId)).color;

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: isMe ? c.backgroundSelected : c.backgroundElement },
      ]}>
      <Text style={[styles.rank, { color: c.textSecondary }]}>{rank}</Text>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <View style={styles.nameWrap}>
        <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
          {entry.displayName ?? anonymous}
        </Text>
        <View style={styles.runsRow}>
          <Text style={[styles.runs, { color: c.textSecondary }]}>{tilesLabel}</Text>
          {/* Tiles claimed by a flagged run still count toward this score —
              the board says so rather than quietly excluding them, same
              posture as the old area board. */}
          {entry.flaggedTileCount > 0 && (
            <>
              <Icon ios="exclamationmark.triangle.fill" android="warning" size={10} color={c.accent} />
              <Text style={[styles.runs, { color: c.accent }]}>{flaggedLabel}</Text>
            </>
          )}
        </View>
      </View>
      <Text style={[styles.area, { color: c.text }]}>{entry.tileCount}</Text>
    </View>
  );
}

function Empty({
  icon,
  android,
  text,
  c,
}: {
  icon: SFSymbol;
  android: AndroidSymbol;
  text: string;
  c: Record<string, string>;
}) {
  return (
    <Animated.View entering={FadeIn.duration(400)} style={styles.centre}>
      <View style={[styles.iconWrap, { backgroundColor: c.backgroundElement }]}>
        <Icon ios={icon} android={android} size={28} color={c.textSecondary} />
      </View>
      <Text style={[styles.emptyText, { color: c.textSecondary }]}>{text}</Text>
    </Animated.View>
  );
}

/** A stable number from a uuid, so a user's accent colour never changes. */
function hashToSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  // fenceColorForRun divides by 1000 (it takes epoch ms), so scale up to
  // keep every bucket reachable.
  return Math.abs(h) * 1000;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.half,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  segment: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
  },
  segmentLabel: { fontSize: 14, fontWeight: '700' },
  list: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1, paddingBottom: BottomTabInset },
  legendsScroll: { paddingBottom: BottomTabInset },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
    paddingBottom: BottomTabInset,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
  rank: { fontSize: 15, fontWeight: '700', minWidth: 22, fontVariant: ['tabular-nums'] },
  dot: { width: 10, height: 10, borderRadius: 5 },
  nameWrap: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '700' },
  runs: { fontSize: 12, fontWeight: '600' },
  runsRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  area: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
