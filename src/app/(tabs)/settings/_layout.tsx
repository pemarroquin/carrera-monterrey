// The Settings tab is a stack, not a screen.
//
// It was one long scroll with four inline sections; each section is now its
// own pushed sub-page, reached from the list in ./index.tsx. Nested inside
// `(tabs)` rather than sitting at the root next to `race/[id]`: a root-level
// `settings/` directory would collide with this tab's own `/settings` route.
// The consequence to know about is that the floating pill tab bar stays
// visible over a pushed sub-page (it is rendered by (tabs)/_layout.tsx and
// does not read nested navigation state) — unlike `race/[id]`, which is a
// root push and covers it. Every sub-page therefore pads its scroll content
// with `BottomTabInset`, via SettingsPage.
//
// Header titles reuse the section keys the old screen already shipped
// (`settings.sectionProfile`, `settings.accountTitle`, `privacy.title`, …),
// so no page title is new, untranslated copy.
import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';

export default function SettingsLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  return (
    <Stack
      // react-navigation's own DefaultTheme/DarkTheme (applied in the root
      // layout) paint the header #fff / #121212 against this app's #ffffff /
      // #000000 page background, which reads as a seam in dark mode. Pin the
      // header to the app's own tokens instead.
      screenOptions={{
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: c.background },
      }}>
      {/* The list screen keeps the tab's own big title and top safe-area
          inset, exactly like every other tab — so entering Settings looks
          unchanged; only its contents became rows. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="profile" options={{ title: t('settings.sectionProfile') }} />
      <Stack.Screen name="history" options={{ title: t('settings.historyTitle') }} />
      <Stack.Screen name="preferences" options={{ title: t('settings.sectionPreferences') }} />
      <Stack.Screen name="location" options={{ title: t('settings.sectionLocation') }} />
      <Stack.Screen name="privacy" options={{ title: t('privacy.title') }} />
      <Stack.Screen name="about" options={{ title: t('settings.sectionAbout') }} />
    </Stack>
  );
}
