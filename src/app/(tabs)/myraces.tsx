// The Saved tab — two collections behind one segmented switch: the races
// you've bookmarked, and the territories you've captured in Territory Mode.
// Pedro's call (2026-08-27): past fences live HERE, not on the live Track
// map — a run-history surface, not run-time chrome.
//
// Territories redesign (2026-09-02, Pedro's ask): one map showing every
// saved territory at once (fit to bounds around ALL of them, however far
// the spread — his call over per-city scoping), not a scrolling list of
// fence-card thumbnails. Tapping a territory opens a detail card with its
// stats and actions. A run still in the offline retry queue (see
// upload-queue.ts) shows too, in a visually distinct PENDING state — Pedro,
// mid-session: "let's show it on the unified map but ... a different state
// that reflects that area haven't been uploaded", with Retry/Delete in its
// card; it promotes to the normal saved look automatically the moment its
// upload succeeds.
import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RaceCard } from '@/components/race-card';
import { MunicipioProgressList } from '@/components/municipio-progress';
import { TerritoriesMap, type TerritoryFeature } from '@/components/territories-map';
import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { daysUntil, type Race } from '@/lib/races';
import { useRaces } from '@/lib/races-provider';
import { onIdentityChanged } from '@/lib/auth-events';
import { onRunSaved, notifyRunSaved } from '@/lib/save-events';
import { useSaved } from '@/lib/saved';
import {
  deleteRun,
  fetchMyFences,
  uploadRun,
  type DeleteOutcome,
  type FencesOutcome,
  type MyFence,
  type SyncOutcome,
} from '@/lib/territory-sync';
import { useToday } from '@/lib/today';
import { formatArea, formatDistance } from '@/lib/tracking';
import { listQueued, removeQueued, type QueuedRun } from '@/lib/upload-queue';

interface RaceSection {
  key: 'upcoming' | 'past';
  title: string;
  data: Race[];
}

type SavedView = 'races' | 'fences' | 'progress';

/** What the detail card is currently showing — the id plus enough to route
 *  the right actions (kind) without re-deriving it from the two lists on
 *  every render. */
interface Selection {
  id: string;
  kind: 'saved' | 'pending';
}

export default function MyRacesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t, locale } = useI18n();
  const { savedIds, dropMissing, storageError } = useSaved();
  const allRaces = useRaces();
  const today = useToday();

  const [view, setView] = useState<SavedView>('races');
  const isFocused = useIsFocused();

  const races = useMemo(
    () => allRaces.filter((r) => savedIds.has(r.id)),
    [savedIds, allRaces],
  );

  // Saved ids the catalog no longer contains. Counted rather than inferred
  // from `races.length` alone so the message stays right if a race is ever
  // saved twice under different ids.
  const missingCount = useMemo(() => {
    const present = new Set(races.map((r) => r.id));
    return Array.from(savedIds).filter((id) => !present.has(id)).length;
  }, [savedIds, races]);

  const clearMissing = useCallback(
    () => dropMissing(new Set(allRaces.map((r) => r.id))),
    [dropMissing, allRaces],
  );

  // Undated races (daysUntil === null) are treated as upcoming — there's no
  // date to have passed. Only a strictly-past date moves a race to "Past".
  const sections = useMemo<RaceSection[]>(() => {
    const upcoming: Race[] = [];
    const past: Race[] = [];
    for (const r of races) {
      const days = daysUntil(r.date, today);
      if (days !== null && days < 0) past.push(r);
      else upcoming.push(r);
    }
    // Upcoming reads soonest-first (inherited from the source sort, which is
    // ascending by date). Past has to be reversed: the same ascending order
    // buries the race you just ran at the bottom under everything older.
    past.reverse();
    const result: RaceSection[] = [];
    if (upcoming.length > 0) {
      result.push({ key: 'upcoming', title: t('myraces.upcomingSection'), data: upcoming });
    }
    if (past.length > 0) {
      result.push({ key: 'past', title: t('myraces.pastSection'), data: past });
    }
    return result;
    // `today` — daysUntil() reads the current date, so without it a race that
    // finished overnight stays under "Próximas" until something else changes.
  }, [races, t, today]);

  // Fences load lazily — fetched (or refetched) each time the Territories
  // view is opened OR the tab regains focus, so a run saved on the Track
  // tab shows up without the runner having to toggle the segment (reported
  // bug: "I have to switch from Races to Territories to trigger the
  // update"). Kept as the raw outcome so the three non-data states
  // (loading / disabled / failed) each render as themselves, never as a
  // fake "no territory yet" — same `isFocused` gate index.tsx's queue-drain
  // effect uses, not a new abstraction.
  const [fences, setFences] = useState<FencesOutcome | null>(null);
  // The offline retry queue — local, synchronous (see upload-queue.ts), so
  // this is a plain read rather than a fetch. Refreshed on the same
  // trigger as `fences` so a run that finishes uploading in the background
  // (index.tsx's own flush effect) shows up here promoted to `fences`
  // without the runner having to leave and come back.
  const [queued, setQueued] = useState<QueuedRun[]>([]);
  const refreshQueued = useCallback(() => setQueued(listQueued()), []);

  // Bumped by save-events.ts whenever a run lands on the server — a fresh
  // autosave, a queued run promoted by index.tsx's background flush, or a
  // manual retry (below). Focus/view alone are NOT enough: a runner can
  // reach this screen, already focused on Territories, before index.tsx's
  // autosave (which starts the instant a run finishes, before the summary
  // screen's checkmark is even tapped) has finished its network round trip
  // — confirmed live twice. Neither `view` nor `isFocused` changes again
  // once that race is lost, so nothing re-triggers the fetch below without
  // this. Folded into the SAME effect via this counter rather than a second
  // fetch effect, so there is exactly one place that knows how to load
  // fences.
  const [saveSignal, setSaveSignal] = useState(0);
  useEffect(() => onRunSaved(() => setSaveSignal((v) => v + 1)), []);

  // Bumped by auth-events.ts when the IDENTITY swaps — a different signal
  // for a different cause, kept separate from saveSignal so neither one's
  // meaning has to stretch. fetchMyFences filters on session.user.id, so a
  // sign-in that lands on another account (account.ts's SIGN IN path)
  // invalidates whatever this screen already fetched, without any run
  // having been saved and without `view`/`isFocused` changing. Without
  // this the runner sees the OLD identity's result — usually an empty map —
  // until something unrelated happens to re-trigger the fetch below.
  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);

  useEffect(() => {
    if (view !== 'fences' || !isFocused) return;
    let stale = false;
    // Deferred by a tick so no setState runs synchronously in the effect
    // body (React Compiler rule — same pattern as the run tracker's clock).
    const id = setTimeout(() => {
      setFences(null);
      refreshQueued();
      fetchMyFences().then((outcome) => {
        if (!stale) setFences(outcome);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [view, isFocused, refreshQueued, saveSignal, identitySignal]);

  // Pull-to-refresh — same refreshing-boolean pattern as leaderboard.tsx's
  // onRefresh, kept separate from the `fences === null` loading state above
  // so a manual pull shows the RefreshControl spinner rather than replacing
  // the whole list with the full-screen ActivityIndicator.
  const [fencesRefreshing, setFencesRefreshing] = useState(false);
  const onRefreshFences = useCallback(async () => {
    setFencesRefreshing(true);
    refreshQueued();
    const outcome = await fetchMyFences();
    setFences(outcome);
    setFencesRefreshing(false);
  }, [refreshQueued]);

  const [selection, setSelection] = useState<Selection | null>(null);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('myraces.title')}</Text>

      <View style={styles.segmentRow}>
        {(['races', 'fences', 'progress'] as const).map((key) => {
          const selected = view === key;
          return (
            <Pressable
              key={key}
              onPress={() => setView(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.segment,
                { backgroundColor: selected ? c.accent : c.backgroundElement },
              ]}>
              <Text
                style={[styles.segmentLabel, { color: selected ? '#ffffff' : c.textSecondary }]}>
                {t(
                  key === 'races'
                    ? 'myraces.tabRaces'
                    : key === 'fences'
                      ? 'myraces.tabFences'
                      : 'myraces.tabProgress',
                )}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {view === 'progress' ? (
        /* Park-path progress per municipio. A THIRD segment on this tab
           rather than a new one: the standing rule here is to look for
           reusable space before adding nav surface, and this is the same
           question the other two answer — what have I done, and where. */
        <ScrollView contentContainerStyle={styles.progressScroll}>
          <MunicipioProgressList c={c} />
        </ScrollView>
      ) : view === 'races' ? (
        <SectionList
          sections={sections}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            // Both of these were tracked in state and rendered nowhere: a
            // browser that blocks storage made every save silently fail, and a
            // race dropped from the catalog just disappeared from this list.
            storageError !== null || missingCount > 0 ? (
              <View style={styles.notices}>
                {storageError !== null && (
                  <View style={[styles.notice, { backgroundColor: c.backgroundElement }]}>
                    <Text style={[styles.noticeText, { color: c.textSecondary }]}>
                      {t('myraces.storageBlocked')}
                    </Text>
                  </View>
                )}
                {missingCount > 0 && (
                  <View style={[styles.notice, { backgroundColor: c.backgroundElement }]}>
                    <Text style={[styles.noticeText, { color: c.textSecondary }]}>
                      {t('myraces.missing', { count: missingCount })}
                    </Text>
                    <Pressable onPress={clearMissing} accessibilityRole="button" hitSlop={10}>
                      <Text style={[styles.noticeAction, { color: c.accent }]}>
                        {t('myraces.clearMissing')}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : null
          }
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>{section.title}</Text>
          )}
          renderItem={({ item, index }) => (
            <Animated.View
              entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
              <RaceCard
                race={item}
                onPress={() => router.push({ pathname: '/race/[id]', params: { id: item.id } })}
              />
            </Animated.View>
          )}
          ListEmptyComponent={
            <Animated.View entering={FadeIn.duration(400)} style={styles.emptyWrap}>
              <Text style={[styles.empty, { color: c.textSecondary }]}>{t('myraces.empty')}</Text>
            </Animated.View>
          }
        />
      ) : (
        <FencesView
          fences={fences}
          queued={queued}
          refreshing={fencesRefreshing}
          onRefresh={onRefreshFences}
          selection={selection}
          onSelect={setSelection}
          locale={locale}
          scheme={scheme}
        />
      )}
    </SafeAreaView>
  );
}

function FencesView({
  fences,
  queued,
  refreshing,
  onRefresh,
  selection,
  onSelect,
  locale,
  scheme,
}: {
  fences: FencesOutcome | null;
  queued: QueuedRun[];
  refreshing: boolean;
  onRefresh: () => void;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  locale: string;
  scheme: 'dark' | 'light';
}) {
  const c = Colors[scheme];
  const { t } = useI18n();

  // Loading and disabled/failed stay their own distinct states — a failure
  // must never quietly render as the empty "no territory yet" copy below.
  if (fences === null) {
    return (
      <View style={styles.emptyWrap}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    );
  }

  if (!fences.ok) {
    // Pull-to-refresh here too — 'disabled' has nothing a refresh would
    // change, but a transient 'failed' (one dropped request) previously
    // left the runner stuck on this screen with no way back short of
    // switching the segment away and back.
    return (
      <ScrollView
        contentContainerStyle={[styles.emptyWrap, styles.emptyWrapGrow]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textSecondary} />
        }>
        <Animated.View entering={FadeIn.duration(400)}>
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {fences.reason === 'disabled'
              ? t('myraces.fencesDisabled')
              : t('myraces.fencesError')}
          </Text>
        </Animated.View>
      </ScrollView>
    );
  }

  // Only what a map can actually draw — a fully-taken run (geometry null,
  // see MyFence's own doc comment) has no shape left, so there is nothing
  // to render or tap. Real history either way; simply not representable on
  // THIS surface. (The old card list showed a metadata-only card for these;
  // this redesign trades that for "a single map view" per Pedro's ask —
  // known, deliberate scope reduction, not an oversight.)
  const savedFeatures: TerritoryFeature[] = fences.fences
    .filter((f) => f.geometry !== null)
    .map((f) => ({
      id: f.id,
      kind: 'saved' as const,
      geometry: f.geometry!,
      route: f.route,
      startedAtMs: f.startedAtMs,
    }));
  const pendingFeatures: TerritoryFeature[] = queued.map((q) => ({
    id: q.id,
    kind: 'pending' as const,
    geometry: q.run.fence.geometry.geometry,
    route: q.run.points,
    startedAtMs: q.run.startedAt,
  }));
  const features = [...savedFeatures, ...pendingFeatures];

  const selectedFence =
    selection?.kind === 'saved' ? fences.fences.find((f) => f.id === selection.id) : undefined;
  const selectedQueued =
    selection?.kind === 'pending' ? queued.find((q) => q.id === selection.id) : undefined;

  if (features.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={[styles.emptyWrap, styles.emptyWrapGrow]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textSecondary} />
        }>
        <Animated.View entering={FadeIn.duration(400)}>
          <Text style={[styles.empty, { color: c.textSecondary }]}>{t('myraces.fencesEmpty')}</Text>
        </Animated.View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.mapStage}>
      <TerritoriesMap features={features} onSelect={(id, kind) => onSelect({ id, kind })} />
      {(selectedFence || selectedQueued) && (
        <DetailCard
          fence={selectedFence}
          queued={selectedQueued}
          locale={locale}
          scheme={scheme}
          onClose={() => onSelect(null)}
          onDeleted={() => onSelect(null)}
        />
      )}
    </View>
  );
}

function DetailCard({
  fence,
  queued,
  locale,
  scheme,
  onClose,
  onDeleted,
}: {
  fence?: MyFence;
  queued?: QueuedRun;
  locale: string;
  scheme: 'dark' | 'light';
  onClose: () => void;
  onDeleted: () => void;
}) {
  const c = Colors[scheme];
  const { t } = useI18n();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<DeleteOutcome | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryFailure, setRetryFailure] = useState<SyncOutcome | null>(null);

  const startedAtMs = fence?.startedAtMs ?? queued?.run.startedAt ?? 0;
  const areaM2 = fence?.areaM2 ?? queued?.run.fence.areaM2 ?? 0;
  const distanceM = fence?.distanceM ?? queued?.run.distanceM ?? 0;
  const date = new Date(startedAtMs).toLocaleDateString(locale === 'es' ? 'es-MX' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const handleDeleteSaved = useCallback(async () => {
    if (!fence) return;
    setDeleting(true);
    setDeleteFailure(null);
    const outcome = await deleteRun(fence.id);
    if (!outcome.ok) {
      setDeleting(false);
      setDeleteFailure(outcome);
      setConfirmingDelete(false);
      return;
    }
    onDeleted();
  }, [fence, onDeleted]);

  const handleDeleteQueued = useCallback(() => {
    if (!queued) return;
    // Local-only, synchronous — no network round trip, but still the
    // runner's ONLY copy of this run (see upload-queue.ts's own header), so
    // it goes through the same two-step confirm as a saved delete rather
    // than firing straight from the button.
    removeQueued(queued.id);
    onDeleted();
  }, [queued, onDeleted]);

  const handleRetry = useCallback(async () => {
    if (!queued) return;
    setRetrying(true);
    setRetryFailure(null);
    const outcome = await uploadRun(queued.run);
    if (!outcome.ok) {
      setRetrying(false);
      setRetryFailure(outcome);
      return;
    }
    // Uploaded — take it out of the local queue so a later background
    // flush (index.tsx) doesn't upload it a second time, same reasoning as
    // save()'s own success path there.
    removeQueued(queued.id);
    // This retry happened FROM the Territories screen itself, so without
    // this the card would close over a map that still shows the old
    // 'pending' feature — this screen's own fetch effect has no other
    // reason to re-run just because the queue changed underneath it. Same
    // signal index.tsx's two producers use; see save-events.ts.
    notifyRunSaved();
    onDeleted();
  }, [queued, onDeleted]);

  return (
    <Animated.View
      entering={FadeInDown.duration(280)}
      style={[styles.detailCard, { backgroundColor: c.backgroundElement }]}>
      <View style={styles.detailHeader}>
        <View style={styles.detailMeta}>
          <Text style={[styles.detailDate, { color: c.text }]}>{date}</Text>
          <Text style={[styles.detailStats, { color: c.textSecondary }]}>
            {formatArea(areaM2)}  ·  {formatDistance(distanceM)}
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" hitSlop={10}>
          <Icon ios="xmark" android="close" size={18} color={c.textSecondary} />
        </Pressable>
      </View>

      {queued && (
        <View style={[styles.pendingBadge, { backgroundColor: c.background }]}>
          <ActivityIndicator size="small" color={c.textSecondary} />
          <Text style={[styles.pendingBadgeText, { color: c.textSecondary }]}>
            {t('myraces.pendingLabel')}
          </Text>
        </View>
      )}

      {fence?.flagged && (
        <View style={styles.detailNoticeRow}>
          <Icon ios="exclamationmark.triangle.fill" android="warning" size={12} color={c.accent} />
          <Text style={[styles.detailNoticeText, { color: c.accent }]}>
            {t('myraces.fenceFlagged')}
          </Text>
        </View>
      )}
      {fence && fence.lostM2 > 0 && (
        <View style={styles.detailNoticeRow}>
          <Icon ios="flag.slash" android="flag" size={12} color={c.accent} />
          <Text style={[styles.detailNoticeText, { color: c.accent }]}>
            {fence.geometry === null
              ? t('myraces.fenceFullyTaken')
              : t('myraces.fenceLost', { area: formatArea(fence.lostM2) })}
          </Text>
        </View>
      )}

      {retryFailure && !retryFailure.ok && (
        <Text style={[styles.detailNoticeText, { color: c.accent }]}>
          {retryFailure.reason === 'disabled'
            ? t('track.syncDisabled')
            : retryFailure.reason === 'auth'
              ? t('track.syncFailedAuth')
              : t('track.syncFailedNetwork')}
        </Text>
      )}
      {deleteFailure && !deleteFailure.ok && (
        <Text style={[styles.detailNoticeText, { color: c.accent }]}>
          {deleteFailure.reason === 'disabled'
            ? t('track.deleteFailedDisabled')
            : deleteFailure.reason === 'auth'
              ? t('track.deleteFailedAuth')
              : deleteFailure.reason === 'denied'
                ? t('track.deleteFailedDenied')
                : t('track.deleteFailedNetwork')}
        </Text>
      )}

      {confirmingDelete ? (
        <View style={styles.detailConfirm}>
          <Text style={[styles.detailNoticeText, { color: c.textSecondary }]}>
            {t('track.deleteConfirmBody')}
          </Text>
          <View style={styles.detailActions}>
            <Pressable onPress={() => setConfirmingDelete(false)} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.detailAction, { color: c.textSecondary }]}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void (queued ? handleDeleteQueued() : handleDeleteSaved())}
              disabled={deleting}
              accessibilityRole="button"
              hitSlop={10}>
              <Text style={[styles.detailAction, { color: c.accent, opacity: deleting ? 0.5 : 1 }]}>
                {deleting ? t('track.deleting') : t('track.deleteConfirmAction')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.detailActions}>
          {queued && (
            <Pressable
              onPress={() => void handleRetry()}
              disabled={retrying}
              accessibilityRole="button"
              hitSlop={10}>
              <Text style={[styles.detailAction, { color: c.accent, opacity: retrying ? 0.5 : 1 }]}>
                {retrying ? t('track.saving') : t('common.retry')}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => setConfirmingDelete(true)}
            disabled={deleting || retrying}
            accessibilityRole="button"
            hitSlop={10}>
            <Text
              style={[
                styles.detailAction,
                { color: c.textSecondary, opacity: deleting || retrying ? 0.5 : 1 },
              ]}>
              {t('track.deleteRun')}
            </Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  progressScroll: { paddingBottom: BottomTabInset },
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
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.two,
  },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: Spacing.six },
  // ScrollView's contentContainerStyle sizes to its content by default —
  // flexGrow (not flex) is what makes short content still fill the
  // viewport, so the pull-to-refresh gesture has room to work from
  // anywhere on screen rather than just the text's own bounds.
  emptyWrapGrow: { flexGrow: 1 },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22, paddingHorizontal: Spacing.four },
  notices: { gap: Spacing.two, marginBottom: Spacing.two },
  notice: { borderRadius: Spacing.two, padding: Spacing.three, gap: Spacing.one },
  noticeText: { fontSize: 13, lineHeight: 19 },
  noticeAction: { fontSize: 13, fontWeight: '700' },

  mapStage: { flex: 1 },
  detailCard: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: BottomTabInset + Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  detailMeta: { gap: Spacing.half },
  detailDate: { fontSize: 16, fontWeight: '700' },
  detailStats: { fontSize: 13, fontWeight: '600' },
  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.half,
    paddingHorizontal: Spacing.two,
    borderRadius: 999,
  },
  pendingBadgeText: { fontSize: 12, fontWeight: '700' },
  detailNoticeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  detailNoticeText: { fontSize: 13, lineHeight: 18 },
  detailConfirm: { gap: Spacing.two },
  detailActions: { flexDirection: 'row', gap: Spacing.four, justifyContent: 'flex-end' },
  detailAction: { fontSize: 14, fontWeight: '700' },
});
