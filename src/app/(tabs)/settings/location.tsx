// Settings › Location & privacy — the privacy zone and the OS location
// permission. The privacy NOTICE (what is collected, what isn't, deletion)
// is its own page: ./privacy.tsx.
//
// Relocated from the old single-file settings screen with no behavioural
// change. `expo-location` is used for one-shot calls only here — never to
// WATCH position; see src/lib/geolocation.ts for why that distinction is
// load-bearing on web.
import * as Location from 'expo-location';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Hint, SettingRow, SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { Spacing, type ThemeColor } from '@/constants/theme';
import {
  getPermissionState,
  onPermissionStateChange,
  requestPermission,
  type GeoPermissionState,
} from '@/lib/geolocation';
import { clearHomeZone, getHomeZone, setHomeZone } from '@/lib/home-point';
import { useI18n } from '@/lib/i18n';
import type { PrivacyZone } from '@/lib/privacy-zone';

export default function LocationSettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();

  // Location permission, stated plainly. Without this the app gives no
  // answer anywhere to "is tracking even allowed?" — and a denied
  // permission looks identical to weak GPS once a session is running,
  // which is exactly how a whole recording session can be lost.
  const isFocused = useIsFocused();
  const [locPerm, setLocPerm] = useState<GeoPermissionState | null>(null);
  const [locBusy, setLocBusy] = useState(false);

  // Read through the app's OWN geolocation layer, not expo-location.
  //
  // This screen used to call Location.getForegroundPermissionsAsync /
  // requestForegroundPermissionsAsync directly, and on web that made the
  // "Enable location" button do nothing at all, silently. The shim
  // (node_modules/expo-location/build/ExpoLocation.web.js) hard-codes
  // `canAskAgain: true` in EVERY branch — including the denied one — so the
  // button always offered to ask, while its request path saw a 'denied'
  // browser state and returned DENIED without ever calling
  // getCurrentPosition. No prompt, no error, no change on screen.
  //
  // Same class of defect, and the same fix, as the watch path this app
  // already bypasses: read the browser, don't trust the shim. See
  // geolocation.web.ts.
  const readPermission = useCallback(() => {
    getPermissionState()
      .then(setLocPerm)
      .catch(() => {
        // Leave whatever is there; the row still reads honestly.
      });
  }, []);

  // Re-read on every focus, not once on mount: on native the fix for a
  // blocked permission is the OS settings app, and coming back here is the
  // moment to re-check.
  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    const id = setTimeout(() => {
      if (!stale) readPermission();
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused, readPermission]);

  // On web the unblock happens in the BROWSER's site settings, with this page
  // still open behind it — no focus change, no reload. Without this the
  // screen would go on saying "Blocked" after the runner had just fixed it,
  // making the instructions look like they had failed. No-op on native.
  useEffect(() => onPermissionStateChange(setLocPerm), []);

  const onFixLocation = useCallback(async () => {
    // Blocked means the prompt is gone for good: the OS has settled it, or
    // the browser has. On native the settings app is the way back.
    // react-native-web's Linking shim has NO openSettings — calling it
    // throws a TypeError inside an async handler with nobody to catch it,
    // and tsc can't see that because the react-native types declare it. On
    // web there is nothing to open, so the button is not rendered at all and
    // the hint carries the instructions instead.
    if (locPerm === 'blocked') {
      if (Platform.OS !== 'web') Linking.openSettings().catch(() => {});
      return;
    }
    setLocBusy(true);
    try {
      // The real prompt. On web this reaches navigator.geolocation directly,
      // which is what actually re-opens the dialog after a DISMISSED prompt
      // — the case this button exists for.
      await requestPermission();
      readPermission();
    } finally {
      setLocBusy(false);
    }
  }, [locPerm, readPermission]);

  // Privacy zone state. Read synchronously from local prefs (same store as
  // theme/locale), so there is no loading flash.
  const [zone, setZone] = useState<PrivacyZone | null>(() => getHomeZone());
  const [zoneBusy, setZoneBusy] = useState(false);
  const [zoneError, setZoneError] = useState(false);
  // Removing the zone is one tap away from uploading the exact start and end
  // of every future session, so it asks first — the same two-step the run
  // delete uses (myraces.tsx's DetailCard), not a modal. SETTING it stays
  // frictionless: only the destructive direction is guarded.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const setZoneHere = useCallback(async () => {
    setZoneBusy(true);
    setZoneError(false);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setZoneError(true);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const ok = setHomeZone({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      // setPref returning false means blocked storage — reporting success
      // there would leave the runner believing they are masked when they
      // are not, which is the worst possible failure for this feature.
      if (!ok) {
        setZoneError(true);
        return;
      }
      setZone(getHomeZone());
    } catch {
      setZoneError(true);
    } finally {
      setZoneBusy(false);
    }
  }, []);

  const clearZone = useCallback(() => {
    clearHomeZone();
    setZone(getHomeZone());
    setZoneError(false);
    setConfirmingRemove(false);
  }, []);

  return (
    <SettingsPage>
      {/* Privacy zone. Set from wherever the runner is standing rather
          than a map picker: "here" is the common case (you set it at
          home), and it needs no new screen. The point NEVER leaves the
          device — see privacy-zone.ts. */}
      <View style={settingsStyles.block}>
        <SettingRow label={t('settings.privacyZone')} c={c}>
          <Status on={zone !== null} label={zone ? t('settings.zoneOn') : t('settings.zoneOff')} c={c} />
        </SettingRow>
        <Hint c={c}>
          {zoneError
            ? t('settings.zoneFailed')
            : zone
              ? t('settings.zoneOnHint', { m: zone.radiusM })
              : t('settings.zoneOffHint')}
        </Hint>
        {confirmingRemove && zone ? (
          <View style={styles.confirm}>
            <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>
              {t('settings.zoneRemoveConfirmBody')}
            </Text>
            <View style={styles.confirmActions}>
              <Pressable
                onPress={() => setConfirmingRemove(false)}
                accessibilityRole="button"
                hitSlop={10}>
                <Text style={[styles.action, { color: c.textSecondary }]}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable onPress={clearZone} accessibilityRole="button" hitSlop={10}>
                <Text style={[styles.action, { color: c.accent }]}>
                  {t('settings.zoneRemoveConfirmAction')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <RowAction
            onPress={zone ? () => setConfirmingRemove(true) : setZoneHere}
            busy={zoneBusy}
            c={c}>
            {zoneBusy
              ? t('settings.zoneSetting')
              : zone
                ? t('settings.zoneRemove')
                : t('settings.zoneSetHere')}
          </RowAction>
        )}
      </View>

      <View style={settingsStyles.block}>
        <SettingRow label={t('settings.location')} c={c}>
          <Status
            on={locPerm === 'granted'}
            // Not-yet-read and no-provider are NOT "off". Painting either the
            // same red as a blocked permission claims a problem nobody has
            // verified.
            unknown={locPerm === null || locPerm === 'unknown'}
            label={
              locPerm === null || locPerm === 'unknown'
                ? t('settings.locationUnknown')
                : locPerm === 'granted'
                  ? t('settings.locationOn')
                  : locPerm === 'askable'
                    ? t('settings.locationNotSet')
                    : t('settings.locationOff')
            }
            c={c}
          />
        </SettingRow>
        <Hint c={c}>
          {locPerm === 'granted'
            ? t('settings.locationOnHint')
            : locPerm === 'blocked' && Platform.OS === 'web'
              ? // The one case with no button: a browser will not re-open a
                // prompt it has been told to stop showing, so the hint has
                // to carry the actual gesture instead of a control that
                // cannot work.
                t('settings.locationBrowserBlockedHint')
              : t('settings.locationOffHint')}
        </Hint>
        {locPerm !== null && locPerm !== 'granted' && !(locPerm === 'blocked' && Platform.OS === 'web') && (
          <RowAction onPress={onFixLocation} busy={locBusy} c={c}>
            {locPerm === 'blocked'
              ? t('settings.locationOpenSettings')
              : t('settings.locationEnable')}
          </RowAction>
        )}
      </View>
    </SettingsPage>
  );
}

/**
 * The state of a setting, in the slot to the right of its label.
 *
 * That slot means STATUS on this page and nothing else, which is the point
 * of this component existing. Before 2026-09-09 the two blocks used it for
 * opposite things: Location put its state there (a dot and "On"), while
 * Privacy zone put its ACTION there — a red "Remove" — and stated whether it
 * was on at all in the first word of the paragraph below. Reported as "On is
 * signaled within the text and is not notorious at all, and instead of being
 * in the same place as location, the remove button is there."
 *
 * Reading down the page, the eye landed on a red word in the position where
 * the row underneath showed a green state. The most prominent thing in the
 * block was the way to switch the protection OFF.
 */
function Status({
  on,
  unknown = false,
  label,
  c,
}: {
  on: boolean;
  unknown?: boolean;
  label: string;
  c: Record<ThemeColor, string>;
}) {
  return (
    <View style={styles.statusWrap}>
      <View
        style={[
          styles.statusDot,
          { backgroundColor: unknown ? c.textSecondary : on ? STATUS_ON : c.accent },
        ]}
      />
      <Text style={[styles.statusValue, { color: c.text }]}>{label}</Text>
    </View>
  );
}

/**
 * The way to CHANGE a setting: always under its hint, never in the status
 * slot. The counterpart to Status, and the other half of the same rule.
 *
 * Below the hint rather than beside the label because the hint is what
 * argues for pressing it — "without a privacy zone, the exact start and end
 * of your sessions are uploaded" is the reason "Use my location" is there,
 * and an action above its own reason reads as a switch rather than a choice.
 */
function RowAction({
  onPress,
  busy,
  c,
  children,
}: {
  onPress: () => void;
  busy: boolean;
  c: Record<ThemeColor, string>;
  children: string;
}) {
  return (
    <Pressable onPress={onPress} disabled={busy} accessibilityRole="button" hitSlop={10}>
      <Text style={[styles.action, { color: c.accent, opacity: busy ? 0.5 : 1 }]}>{children}</Text>
    </Pressable>
  );
}

/** The "this is on and working" green. Local to this screen: it is the only
 *  place in the app that paints a status dot, and constants/theme.ts has no
 *  positive colour to belong to — every other accent there is the one red.
 *  Promote it if a second screen ever needs it. */
const STATUS_ON = '#2FBF71';

const styles = StyleSheet.create({
  confirm: { gap: Spacing.two },
  confirmActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.four },
  statusWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusValue: { fontSize: 15, fontWeight: '600' },
  action: { fontSize: 14, fontWeight: '700' },
});
