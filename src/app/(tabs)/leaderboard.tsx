// The leaderboard. ONE screen, ONE arena, no mode toggles.
//
// WHAT WAS WRONG, in Pedro's words: "Leaderboard navigation is totally off.
// What is Regulars? Why does regulars have Monterrey and Global territory?"
//
// The old screen stacked two identical-looking pill rows that crossed two
// unrelated axes — WHICH GAME (`Territory` / `Regulars`) by WHERE
// (`Monterrey` / `Global`). Four combinations, one of them meaningless (a
// global list of user-drawn shapes across cities), and neither row said what
// it measured. "Regulars" was also a demographic rather than a game, and the
// thing it ranked was a user-NAMED shape, which is gone entirely.
//
// Both axes are removed rather than relabelled:
//
//   WHERE collapses to the district you are standing in (district.ts). There
//   is nothing to choose — it is where you are. A leaderboard scoped to
//   ground you cannot reach on foot was never a contest.
//
//   WHICH GAME collapses to two labelled sections on one scroll. They were
//   behind a toggle for a real reason (two incomparable numbers must not read
//   as one ranking), and that reason is answered by every row stating its own
//   unit instead of by hiding one board from the other.
//
// The share bar, not the list, is the thing you look at first — "having
// leaderboard with only cards is boring and i do not like it at all". See
// share-bar.tsx for why a bar survives having one player and a card list
// does not.
import { useIsFocused } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BoardRow } from '@/components/board-row';
import { DistrictMap, type DistrictHolding } from '@/components/district-map';
import { ShareBar, type ShareSegment } from '@/components/share-bar';
import { Icon } from '@/components/ui/icon';
import { fenceColorForRun } from '@/constants/map';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { onIdentityChanged } from '@/lib/auth-events';
import { fetchDistrictParkCells, fetchDistrictVisits, type ParkCell } from '@/lib/boards';
import { districtLabel, districtOf, districtOfCell } from '@/lib/district';
import { useI18n } from '@/lib/i18n';
import { districtConquest, type TileOwnerRow } from '@/lib/leaderboard';
import {
  MAYORSHIP_WINDOW_DAYS,
  contestedCells,
  mayorByCell,
  rankMayors,
} from '@/lib/mayorship';
import { useCurrentLocation } from '@/lib/use-current-location';
import { fetchTileLeaderboard } from '@/lib/territory-sync';

/** Everything the screen needs, resolved together. `null` is "not loaded
 *  yet"; a failed piece keeps the others — a district with no park data must
 *  still show who holds it. */
interface BoardData {
  tiles: TileOwnerRow[] | null;
  meUserId: string | null;
  parkCells: Set<string>;
  parkRows: ParkCell[];
  visits: Parameters<typeof mayorByCell>[0];
  failed: boolean;
}

export default function LeaderboardScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const isFocused = useIsFocused();
  // The arena follows the runner. A real fix or nothing — never a region
  // fallback, for the same reason the Track map refuses to place its pin on a
  // city centre: this decides which ground a runner is being ranked on, and
  // a guess would rank them somewhere they have never been.
  const { coords } = useCurrentLocation();

  const district = useMemo(() => (coords ? districtOf(coords) : null), [coords]);

  const [data, setData] = useState<BoardData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);

  const load = useCallback(async (forDistrict: string): Promise<BoardData> => {
    // In parallel: three independent reads with no ordering between them.
    const [board, parks, visits] = await Promise.all([
      fetchTileLeaderboard(),
      fetchDistrictParkCells(forDistrict),
      fetchDistrictVisits(forDistrict),
    ]);
    return {
      tiles: board.ok ? board.tiles : null,
      meUserId: board.ok ? board.meUserId : null,
      parkCells: parks.ok ? parks.cells : new Set<string>(),
      parkRows: parks.ok ? parks.parkCells : [],
      visits: visits.ok ? visits.visits : [],
      // Only the ownership read failing is a failed BOARD. Missing park data
      // is a normal state (most of the planet) and missing visits just means
      // an empty Local Leaders section.
      failed: !board.ok,
    };
  }, []);

  // Refetches on every focus, not just first mount: expo-router keeps tab
  // screens mounted, so a `[]`-deps effect would fetch once early in the
  // session and never again. Same reasoning — and the same identity signal —
  // as the screen this replaced.
  useEffect(() => {
    if (!isFocused || district === null) return;
    let stale = false;
    const id = setTimeout(() => {
      load(district).then((next) => {
        if (!stale) setData(next);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused, district, identitySignal, load]);

  const onRefresh = useCallback(async () => {
    if (district === null) return;
    setRefreshing(true);
    setData(await load(district));
    setRefreshing(false);
  }, [district, load]);

  // ---- Board 1: conquest, as a share of this district's park paths --------
  const conquest = useMemo(() => {
    if (!data?.tiles || district === null) return null;
    return districtConquest(data.tiles, district, data.parkCells);
  }, [data, district]);

  // ---- Board 2: mayorship over ground people keep coming back to ----------
  const mayors = useMemo(() => (data ? mayorByCell(data.visits) : null), [data]);
  const leaders = useMemo(
    () => (data && district !== null ? rankMayors(data.visits, district) : null),
    [data, district],
  );

  const label = useMemo(
    () => (district !== null && data ? districtLabel(district, data.parkRows) : null),
    [district, data],
  );

  // ---- Your own standing, which is the hero ------------------------------
  const me = conquest?.entries.find((e) => e.userId === data?.meUserId) ?? null;
  const myRank = me ? (conquest?.entries.indexOf(me) ?? -1) + 1 : 0;
  const contested = useMemo(() => {
    if (!data?.tiles || !mayors || !data.meUserId || district === null) return 0;
    const mine = data.tiles
      .filter((tile) => tile.ownerId === data.meUserId)
      .map((tile) => tile.h3);
    return contestedCells(mine, mayors, data.meUserId).length;
  }, [data, mayors, district]);

  // The map's input. Same source as the share bar and the rows — one fetch,
  // three views of it, so they can never disagree about who holds what.
  const holdings = useMemo<DistrictHolding[]>(() => {
    if (!data?.tiles || district === null) return [];
    const byOwner = new Map<string, string[]>();
    for (const tile of data.tiles) {
      if (districtOfCell(tile.h3) !== district) continue;
      const cells = byOwner.get(tile.ownerId);
      if (cells) cells.push(tile.h3);
      else byOwner.set(tile.ownerId, [tile.h3]);
    }
    return [...byOwner.entries()].map(([userId, cells]) => ({
      userId,
      cells,
      color: tintFor(userId),
      isMe: userId === data.meUserId,
    }));
  }, [data, district]);

  const shareSegments = useMemo<ShareSegment[]>(() => {
    if (!conquest || !conquest.hasDenominator) return [];
    return conquest.entries.map((entry) => ({
      key: entry.userId,
      share: entry.share,
      color: tintFor(entry.userId),
      label: `${entry.displayName ?? t('leaderboard.anonymous')} ${pct(entry.share)}`,
      isMe: entry.userId === data?.meUserId,
    }));
  }, [conquest, data, t]);

  if (district === null) {
    return (
      <Shell c={c} title={t('leaderboard.title')}>
        <Empty
          icon="location.fill"
          android="my_location"
          text={t('leaderboard.needLocation')}
          c={c}
        />
      </Shell>
    );
  }

  if (data === null) {
    return (
      <Shell c={c} title={t('leaderboard.title')}>
        <View style={styles.centre}>
          <ActivityIndicator color={c.textSecondary} />
        </View>
      </Shell>
    );
  }

  if (data.failed) {
    return (
      <Shell c={c} title={t('leaderboard.title')}>
        <Empty icon="exclamationmark.triangle" android="warning" text={t('leaderboard.error')} c={c} />
      </Shell>
    );
  }

  const hasDenominator = conquest?.hasDenominator === true;

  return (
    <Shell c={c} title={t('leaderboard.title')}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textSecondary} />
        }>
        {/* THE ARENA. A caption, not a control — there is nothing to pick.
            `label` is null wherever no park data exists (most of the planet),
            and the fallback says "where you are" rather than inventing a
            place name. See districtLabel's own comment. */}
        <Animated.View entering={FadeIn.duration(300)} style={styles.arena}>
          <Text style={[styles.arenaKicker, { color: c.textSecondary }]}>
            {t('leaderboard.arenaKicker')}
          </Text>
          <Text style={[styles.arenaName, { color: c.text }]} numberOfLines={1}>
            {label ?? t('leaderboard.arenaHere')}
          </Text>
        </Animated.View>

        {/* THE HERO — your own standing, as the biggest thing on screen. */}
        <Animated.View
          entering={FadeInDown.duration(340)}
          style={[styles.hero, { backgroundColor: c.backgroundElement }]}>
          <Text style={[styles.heroValue, { color: c.text }]}>
            {hasDenominator ? pct(me?.share ?? 0) : String(me?.cellsHeld ?? 0)}
          </Text>
          <Text style={[styles.heroCaption, { color: c.textSecondary }]}>
            {/* Two different sentences, because 0/0 is not 0%. A district
                with no park data must never tell a runner who just covered
                their whole neighbourhood that they hold none of it. */}
            {hasDenominator
              ? t('leaderboard.heroParkShare')
              : t('leaderboard.heroCellsHeld')}
          </Text>
          <View style={styles.heroChips}>
            <Chip
              text={myRank > 0 ? t('leaderboard.rankOf', { rank: myRank, total: conquest?.entries.length ?? 0 }) : t('leaderboard.unranked')}
              c={c}
            />
            {contested > 0 && (
              <Chip text={t('leaderboard.contested', { count: contested })} c={c} tone={c.accent} />
            )}
          </View>
        </Animated.View>

        {/* WHERE the ground is. Keyed on the district so a new arena
            remounts with a new camera frame rather than animating there —
            see the map's own mount-effect comment. Hidden when nobody holds
            anything: an empty frame is not a picture of a contest. */}
        {holdings.length > 0 && (
          <Animated.View entering={FadeInDown.duration(340).delay(40)}>
            <DistrictMap key={district} district={district} holdings={holdings} />
          </Animated.View>
        )}

        {/* WHO HOLDS THIS PLACE, as one bar. Only where there is a real
            denominator — a bar of nothing is not a picture of anything. */}
        {hasDenominator && shareSegments.length > 0 && (
          <Animated.View entering={FadeInDown.duration(340).delay(60)} style={styles.block}>
            <ShareBar
              segments={shareSegments}
              c={c}
              unclaimedLabel={t('leaderboard.unclaimed', {
                pct: pct(Math.max(0, 1 - shareSegments.reduce((s, x) => s + x.share, 0))),
              })}
              othersLabel={t('leaderboard.others')}
            />
          </Animated.View>
        )}

        {/* BOARD 1 */}
        <Section
          title={t('leaderboard.conquestTitle')}
          note={t('leaderboard.conquestNote')}
          c={c}>
          {conquest && conquest.entries.length > 0 ? (
            conquest.entries.map((entry, i) => (
              <BoardRow
                key={entry.userId}
                rank={i + 1}
                name={entry.displayName ?? t('leaderboard.anonymous')}
                score={hasDenominator ? pct(entry.share) : String(entry.cellsHeld)}
                detail={t('leaderboard.cellsDetail', { count: entry.cellsHeld })}
                tint={tintFor(entry.userId)}
                isMe={entry.userId === data.meUserId}
                flaggedLabel={
                  entry.flaggedCellsHeld > 0
                    ? t('leaderboard.flaggedTiles', { count: entry.flaggedCellsHeld })
                    : undefined
                }
                c={c}
              />
            ))
          ) : (
            <Text style={[styles.note, { color: c.textSecondary }]}>
              {t('leaderboard.conquestEmpty')}
            </Text>
          )}
        </Section>

        {/* BOARD 2 */}
        <Section
          title={t('leaderboard.leadersTitle')}
          note={t('leaderboard.leadersNote', { days: MAYORSHIP_WINDOW_DAYS })}
          c={c}>
          {leaders && leaders.length > 0 ? (
            leaders.map((entry, i) => (
              <BoardRow
                key={entry.userId}
                rank={i + 1}
                name={entry.displayName ?? t('leaderboard.anonymous')}
                score={String(entry.cellsHeld)}
                detail={t('leaderboard.bestDays', { count: entry.bestDays })}
                tint={tintFor(entry.userId)}
                isMe={entry.userId === data.meUserId}
                c={c}
              />
            ))
          ) : (
            <Text style={[styles.note, { color: c.textSecondary }]}>
              {t('leaderboard.leadersEmpty', { days: MAYORSHIP_WINDOW_DAYS })}
            </Text>
          )}
        </Section>
      </ScrollView>
    </Shell>
  );
}

function Shell({
  c,
  title,
  children,
}: {
  c: Record<ThemeColor, string>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      {children}
    </SafeAreaView>
  );
}

function Section({
  title,
  note,
  c,
  children,
}: {
  title: string;
  note: string;
  c: Record<ThemeColor, string>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.block}>
      <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
      {/* Every section states what it measures. This is what lets both
          boards share one screen — see this file's header. */}
      <Text style={[styles.sectionNote, { color: c.textSecondary }]}>{note}</Text>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

function Chip({
  text,
  c,
  tone,
}: {
  text: string;
  c: Record<ThemeColor, string>;
  tone?: string;
}) {
  return (
    <View style={[styles.chip, { backgroundColor: c.backgroundSelected }]}>
      <Text style={[styles.chipText, { color: tone ?? c.textSecondary }]}>{text}</Text>
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
  c: Record<ThemeColor, string>;
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

/**
 * A share as a percentage string.
 *
 * Two decimals below 1%, because that is the range this app actually lives
 * in — one 5.7 km run is 5.5% of a municipio's park paths, and a district is
 * smaller still, but a runner's FIRST run can easily be 0.4%. Rounding that
 * to "0%" would tell them their run did nothing.
 */
function pct(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share < 0.01) return `${(share * 100).toFixed(2)}%`;
  if (share < 0.1) return `${(share * 100).toFixed(1)}%`;
  return `${Math.round(share * 100)}%`;
}

/** A runner's accent, stable for the life of their account. Keyed on the
 *  user id, NOT their fence colour (which is per-run by design), so one
 *  person reads as one colour down the whole screen and in the share bar. */
function tintFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  // fenceColorForRun takes epoch ms and divides by 1000, so scale up to keep
  // every bucket reachable.
  return fenceColorForRun(Math.abs(h) * 1000).color;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  scroll: { padding: Spacing.three, gap: Spacing.four, paddingBottom: BottomTabInset },
  arena: { gap: 2 },
  arenaKicker: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  arenaName: { fontSize: 22, fontWeight: '700' },
  hero: { borderRadius: Spacing.three, padding: Spacing.four, gap: Spacing.one },
  heroValue: { fontSize: 52, fontWeight: '800', fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 14, lineHeight: 19 },
  heroChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, paddingTop: Spacing.two },
  chip: { paddingVertical: 4, paddingHorizontal: Spacing.two, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '700' },
  block: { gap: Spacing.two },
  sectionTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 0.8 },
  sectionNote: { fontSize: 13, lineHeight: 18 },
  rows: { gap: Spacing.two, paddingTop: Spacing.one },
  note: { fontSize: 13, lineHeight: 19 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
    paddingBottom: BottomTabInset,
  },
  iconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
