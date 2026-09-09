// Portrait-only, on the web.
//
// A browser tab CANNOT be orientation-locked, and it is worth being exact
// about why, because it looks like it should be possible:
//
//   - app.json's `orientation: 'portrait'` is a NATIVE manifest key. Expo
//     web never emits it anywhere a browser reads.
//   - `screen.orientation.lock('portrait')` exists in the spec but is not
//     implemented in Safari at all, on any platform, and where it IS
//     implemented it throws outside fullscreen or an installed PWA. It is
//     attempted below anyway, on a best-effort basis, since it genuinely
//     works for an installed Android PWA — but it can never be the answer
//     for the surface this app is actually used on (an iOS Safari tab).
//   - Counter-rotating the app 90° in CSS "keeps the layout portrait" and
//     breaks the one screen that matters: a transformed ancestor puts
//     Mapbox GL's hit-testing and touch gestures in a different coordinate
//     space than the pointer events it receives. The map would look right
//     and not respond where you touched.
//
// So the honest implementation is to REFUSE landscape rather than pretend to
// prevent it: cover the app until the phone comes back upright. Nothing
// unmounts behind this overlay, so a recording session keeps running — which
// the copy says out loud, because a runner who sees a full-screen takeover
// mid-run needs to know their run is still being recorded.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';

/**
 * Landscape AND short AND touch — all three, because "landscape" alone is
 * every desktop browser ever opened, and gating those would be a bug rather
 * than a feature.
 *
 * `max-height: 550px` is what separates a phone held sideways from a tablet
 * or a laptop: no phone in landscape is taller than that, and nothing else
 * is shorter. `pointer: coarse` then excludes a narrow desktop window
 * someone happened to drag short.
 */
const LANDSCAPE_PHONE = '(orientation: landscape) and (max-height: 550px) and (pointer: coarse)';

/** Best-effort, and expected to fail on the surface this app is used on —
 *  see this file's header. Never throws: the lock rejects asynchronously in
 *  some browsers and synchronously in others. */
function tryLockPortrait() {
  try {
    const orientation = window.screen?.orientation as
      | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
      | undefined;
    void orientation?.lock?.('portrait').catch(() => {});
  } catch {
    // No lock API, or refused outside fullscreen. The overlay is the fallback.
  }
}

export function PortraitGate() {
  const { t } = useI18n();
  const scheme = useColorScheme();
  const c = Colors[scheme === 'dark' ? 'dark' : 'light'];
  // Starts false and is corrected in the effect below rather than read
  // during render: `matchMedia` does not exist during a static export's
  // prerender, and the first client paint being "not gated" is the right
  // default anyway — the overlay appearing is what needs to be deliberate.
  const [sideways, setSideways] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    tryLockPortrait();

    const query = window.matchMedia(LANDSCAPE_PHONE);
    const apply = () => setSideways(query.matches);
    apply();
    // `change` on the MediaQueryList, not a window resize listener: iOS
    // Safari fires resize while its URL bar collapses, which would flap the
    // overlay on and off during a scroll that never rotated anything.
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  if (!sideways) return null;

  return (
    <View
      // Not `pointer-events: none` anywhere on this: intercepting touches is
      // half the point. A phone sideways in a pocket must not be able to
      // fire the Stop button.
      style={[StyleSheet.absoluteFill, styles.wrap, { backgroundColor: c.background }]}
      accessibilityRole="alert"
    >
      <Text style={[styles.icon, { color: c.accent }]}>⟲</Text>
      <Text style={[styles.title, { color: c.text }]}>{t('orientation.title')}</Text>
      <Text style={[styles.body, { color: c.textSecondary }]}>{t('orientation.body')}</Text>
      <Text style={[styles.body, styles.running, { color: c.textSecondary }]}>
        {t('orientation.running')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    // Above every other overlay in the root layout (the splash, the email
    // banner): this one is a refusal to render the app at all, so nothing
    // may sit on top of it.
    zIndex: 100,
  },
  icon: { fontSize: 44, marginBottom: Spacing.three },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center', marginBottom: Spacing.two },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 420 },
  running: { marginTop: Spacing.three, fontWeight: '600' },
});
