// Settings — the list screen. Every row pushes a sub-page in this tab's
// stack (see ./_layout.tsx); nothing is configured from here.
//
// The Account group is hidden wholesale when Territory Mode has no server
// configured. That preserves exactly what the old single-file screen did:
// it hid the Profile section when `fetchMyProfile()` came back
// `reason: 'disabled'`, which `withSession` returns if and only if
// TERRITORY_ENABLED is false — so the synchronous constant is the same
// condition without a round trip, and without a row that leads to a page
// with nothing on it.
//
// Layout follows the settings list every phone user already knows (Pedro's
// reference, 2026-09-04: Instagram's "Settings and activity"): full-bleed
// rows straight on the page background, a plain outline icon leading, the
// chevron pinned to the trailing edge, and groups separated by a solid band
// rather than each being a rounded card. No dividers between rows inside a
// group — the band and the group labels carry the structure, so the list
// reads as one column instead of a stack of floating panels.
import { Link, type Href } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { TERRITORY_ENABLED } from '@/lib/supabase';
import { fetchMyProfile } from '@/lib/territory-sync';

export default function SettingsIndexScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  // Warm the Profile page's data while the runner is still reading this list.
  // The result is written to the local cache by fetchMyProfile itself, so the
  // sub-page seeds from it (profile-cache.ts) — this only buys the round trip
  // a head start, it is not what removes the blank field. The cache is.
  //
  // One call covers the Account page too: fetchAccountStatus does no query of
  // its own, it reads the email off the session, so what both pages actually
  // wait on is ensureSession() — and this warms that.
  //
  // Mount-only, and that is once per app run in practice: expo-router keeps
  // tab screens mounted, so returning to Settings does not re-fire it.
  // Deliberately unawaited and unhandled — every outcome is already recorded
  // in the cache or ignored, and a failure here must not surface as anything
  // on a screen the runner didn't ask a question on.
  useEffect(() => {
    if (!TERRITORY_ENABLED) return;
    void fetchMyProfile();
  }, []);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('settings.title')}</Text>
      <ScrollView contentContainerStyle={styles.container}>
        {TERRITORY_ENABLED && (
          <>
            <GroupLabel c={c}>{t('settings.groupAccount')}</GroupLabel>
            <NavRow
              href="/settings/profile"
              ios="person.crop.circle"
              android="account_circle"
              label={t('settings.sectionProfile')}
              hint={t('settings.navProfileHint')}
              c={c}
            />
            {/* The permanent personal record, deliberately here rather than
                on the live map: under conquest that map shows what you hold
                RIGHT NOW and can fall while you sleep, so "everywhere I have
                been" needed a surface nobody can take from you. */}
            <NavRow
              href="/settings/history"
              ios="map"
              android="map"
              label={t('settings.historyTitle')}
              hint={t('settings.historyNavHint')}
              c={c}
            />
            <GroupBreak c={c} />
          </>
        )}

        <GroupLabel c={c}>{t('settings.groupApp')}</GroupLabel>
        <NavRow
          href="/settings/preferences"
          ios="slider.horizontal.3"
          android="tune"
          label={t('settings.sectionPreferences')}
          hint={t('settings.navPreferencesHint')}
          c={c}
        />
        <NavRow
          href="/settings/location"
          ios="location"
          android="location_on"
          label={t('settings.sectionLocation')}
          hint={t('settings.navLocationHint')}
          c={c}
        />
        {/* The privacy NOTICE, distinct from the location/privacy controls
            above it — the two hints are what tell them apart, which is
            exactly what the hints are for. */}
        <NavRow
          href="/settings/privacy"
          ios="lock"
          android="lock"
          label={t('privacy.title')}
          hint={t('settings.navPrivacyHint')}
          c={c}
        />
        <NavRow
          href="/settings/about"
          ios="info.circle"
          android="info"
          label={t('settings.sectionAbout')}
          hint={t('settings.navAboutHint')}
          c={c}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function GroupLabel({ children, c }: { children: string; c: Record<ThemeColor, string> }) {
  return <Text style={[styles.groupLabel, { color: c.textSecondary }]}>{children}</Text>;
}

/** The band between groups. Full-bleed on purpose — it is the only thing
 *  separating one group from the next now that the rows aren't in cards, so
 *  it has to read as a break in the page, not as an inset rule. */
function GroupBreak({ c }: { c: Record<ThemeColor, string> }) {
  return <View style={[styles.groupBreak, { backgroundColor: c.backgroundElement }]} />;
}

function NavRow({
  href,
  ios,
  android,
  label,
  hint,
  c,
}: {
  // `Link` rather than `router.push`: it renders a real anchor on web, so the
  // rows are keyboard-focusable and open-in-new-tab works, and it keeps the
  // href visible at the call site for the typed-routes check.
  //
  // `Href`, not `string` — `string` was silently OPTING OUT of that very
  // check. app.json sets `experiments.typedRoutes`, which makes expo-router
  // resolve `Href` to the literal union of this app's real routes, and a
  // prop typed `string` widens right past it. `Href` falls back to a broad
  // type when the generated routes file is absent (it is gitignored, and
  // only `expo start` writes it — not `expo export`), so this costs nothing
  // in CI and enforces properly on any machine that has run the dev server.
  // test/route-hrefs.test.ts is what enforces it where CI can actually see.
  href: Href;
  ios: SFSymbol;
  android: AndroidSymbol;
  label: string;
  hint: string;
  c: Record<ThemeColor, string>;
}) {
  return (
    <Link href={href} asChild>
      {/*
        NOTHING may be passed to this Pressable's `style` prop — not a
        function, not an array. `asChild` renders the child through
        expo-router's Slot, which is Radix's, and Radix merges style with
        `{ ...slotStyle, ...childStyle }`. Object-spreading a Pressable's
        style FUNCTION yields `{}` (a function has no enumerable own
        properties), so the row's entire style silently becomes empty: no
        flexDirection, no padding, no alignment. That is exactly what shipped
        — icon, label, hint and chevron each stacked on their own line, flush
        left, which is what a row looks like with no styles at all rather
        than a layout mistake. An array is no safer: expo-router's own Slot
        shim throws on one in dev and flattens it in prod.

        So the layout lives on the View below, and `pressed` comes from the
        children-as-function form, which Slot passes through untouched.
      */}
      <Pressable
        accessibilityRole="link"
        // The hint is part of the row's meaning, not decoration — read it
        // out with the label rather than leaving a screen reader to announce
        // two unrelated strings.
        accessibilityLabel={`${label}. ${hint}`}>
        {({ pressed }) => (
          <View style={[styles.row, pressed && { backgroundColor: c.backgroundElement }]}>
            {/* Regular weight, not the Icon default's semibold: these read as
                outline glyphs beside 17px text, and semibold at 26px turns
                them into heavy blobs. */}
            <Icon ios={ios} android={android} size={26} weight="regular" color={c.text} />
            <View style={styles.rowText}>
              <Text style={[styles.rowLabel, { color: c.text }]}>{label}</Text>
              <Text style={[styles.rowHint, { color: c.textSecondary }]}>{hint}</Text>
            </View>
            <Icon ios="chevron.right" android="chevron_right" size={14} color={c.textSecondary} />
          </View>
        )}
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  // No horizontal padding: the rows and the group band are full-bleed, and
  // each pads its own contents instead.
  container: { paddingBottom: BottomTabInset },
  groupLabel: {
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  groupBreak: { height: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.one,
  },
  // `flex: 1` is what pins the chevron to the trailing edge — the text column
  // takes every pixel the icon and chevron don't.
  rowText: { flex: 1, gap: 1 },
  rowLabel: { fontSize: 17, fontWeight: '500' },
  rowHint: { fontSize: 13, lineHeight: 17 },
});
