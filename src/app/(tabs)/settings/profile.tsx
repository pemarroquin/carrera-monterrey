// Settings › Profile — everything about WHO the runner is, on one page:
// their account, the diagnostics for it, and the name they appear under.
//
// The account controls used to be a sibling page (/settings/account) reached
// by its own row. Pedro's call, 2026-09-09: fold them in here, in that order.
// They are three answers to one question, and splitting them meant a runner
// whose territory had gone missing had to guess which of two rows to open —
// while Diagnostics, the screen that answers it, lived under the row they
// did not pick.
//
// Order is deliberate and is the order of escalation: what account am I
// (AccountLink) → what does the server actually hold for it
// (IdentityDiagnostic) → what do other people see (the leaderboard name).
// Each section carries its own heading; see Section below for why they are
// not index.tsx's GroupLabel.
//
// The name field itself moved out of the old single-file settings screen
// unchanged: same refetch-on-focus effect, same lastSyncedName dirty check,
// same save-on-blur. `useIsFocused` now means "this sub-page is on top of
// the settings stack" rather than "the settings tab is selected", which is
// if anything a tighter fit for the reason the effect exists — NamePrompt
// (the run-summary flow) can write display_name from off-screen while this
// screen stays mounted.
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AccountLink } from '@/components/account-link';
import { IdentityDiagnostic } from '@/components/identity-diagnostic';
import { SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { getCachedDisplayName } from '@/lib/profile-cache';
import { TERRITORY_ENABLED } from '@/lib/supabase';
import { DISPLAY_NAME_MAX, fetchMyProfile, updateDisplayName } from '@/lib/territory-sync';

/** The leaderboard name field — the third section, and the only one with
 *  state of its own. */
function LeaderboardName() {
  const { c } = useSettingsColors();
  const { t } = useI18n();
  const isFocused = useIsFocused();

  // Seeded from the local cache so the field shows the runner's real name on
  // the FIRST paint. Before this, both of these started empty/'loading' and
  // only filled in once fetchMyProfile() came back — which on a phone took
  // long enough (~30s, reported 2026-09-04) that the screen read as blank and
  // then changed under you. The refetch below still runs and still wins; the
  // cache only decides what is on screen while it is in flight. See
  // profile-cache.ts.
  //
  // A lazy useState initializer, not a plain call: this reads storage, and
  // it must run once on mount rather than on every render.
  const [cachedName] = useState(() => getCachedDisplayName());
  const [displayName, setDisplayName] = useState(cachedName ?? '');
  const [nameState, setNameState] = useState<
    'loading' | 'ready' | 'saving' | 'saved' | 'failed' | 'taken' | 'reserved' | 'off'
  >(
    // 'loading' makes the input read-only. With a cached name there is
    // something real to edit immediately, and a save started before the
    // refetch lands is safe — updateDisplayName is an upsert of whatever the
    // field holds, and the refetch's own guard below refuses to overwrite a
    // field the runner has touched.
    cachedName === null ? 'loading' : 'ready',
  );
  // The last value this screen actually confirmed with the server — via a
  // fetch or a successful save. saveName() below diffs `displayName`
  // against this to become a no-op when nothing changed, and the
  // refetch-on-focus effect uses it to tell "the runner hasn't touched the
  // field since we last synced it" (safe to adopt the fetched value) apart
  // from "the runner is mid-edit" (must not clobber what they're typing). A
  // ref, not state: it's read inside a setState updater and inside an
  // async callback, and must never itself trigger a re-render.
  // Seeded from the cache too, and it has to be: the refetch adopts a
  // fetched value only when the field still equals this. Left at '' while
  // the field showed a cached name, every refetch would look like "the
  // runner is mid-edit" and never reconcile.
  const lastSyncedName = useRef(cachedName ?? '');
  // The same value as lastSyncedName, as state, purely so RENDER can react to
  // it — the Save/Discard pair below has to appear the moment the field
  // diverges from what the server holds, and a ref change re-renders nothing.
  // The ref stays the source of truth for the logic that reads it inside a
  // setState updater and inside async callbacks (see its comment above);
  // commitSynced() is the only writer, so the two can never drift.
  const [syncedName, setSyncedName] = useState(cachedName ?? '');
  const commitSynced = useCallback((value: string) => {
    lastSyncedName.current = value;
    setSyncedName(value);
  }, []);

  // Re-fetch on every focus, not once on mount: NamePrompt can write
  // display_name from off-screen while this screen stays mounted (expo-router
  // keeps screens alive; there's no unmountOnBlur/freezeOnBlur anywhere in
  // this app), so a mount-only fetch would keep showing the stale value after
  // that. The functional setDisplayName below only adopts the fetched value
  // when the field still matches what was last synced — if the runner has
  // since typed something new, a refetch landing mid-edit must not overwrite
  // it.
  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    // Deferred so no setState runs synchronously in the effect body.
    const id = setTimeout(() => {
      fetchMyProfile().then((outcome) => {
        if (stale) return;
        if (outcome.ok) {
          const fetched = outcome.displayName ?? '';
          setDisplayName((prev) => (prev === lastSyncedName.current ? fetched : prev));
          commitSynced(fetched);
          // Don't stomp a save that's currently in flight.
          setNameState((prev) => (prev === 'saving' ? prev : 'ready'));
        } else {
          // 'disabled' is a build configuration, not a failure — hide the
          // field entirely rather than showing one that can't save.
          setNameState(outcome.reason === 'disabled' ? 'off' : 'failed');
        }
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused, commitSynced]);

  // Saved on blur rather than per keystroke: one write when the runner is
  // done, instead of a request per character. Dirty-checked against
  // lastSyncedName so a blur/submit on a field the runner merely tapped
  // into and back out of is a no-op, not a write — onBlur/onSubmitEditing
  // fire unconditionally, and this screen can go stale while mounted (see
  // the refetch effect above), so without this check that no-op tap can
  // silently overwrite a name set from elsewhere with a stale local value.
  const saveName = useCallback(async () => {
    if (nameState === 'off' || nameState === 'loading') return;
    if (displayName === lastSyncedName.current) return;
    setNameState('saving');
    const outcome = await updateDisplayName(displayName);
    // Sync to the server-confirmed value (trimmed/nulled server-side), not
    // the raw input, so the next dirty-check compares against the truth.
    if (outcome.ok) commitSynced(outcome.displayName ?? '');
    // 'taken' and 'reserved' keep the field dirty on purpose: the runner's
    // edit is still there to fix, and the Save/Discard pair stays on screen.
    // Collapsing them into 'failed' would tell someone whose nickname is
    // merely taken to go check their connection.
    setNameState(
      outcome.ok
        ? 'saved'
        : outcome.reason === 'taken'
          ? 'taken'
          : outcome.reason === 'reserved'
            ? 'reserved'
            : 'failed',
    );
  }, [displayName, nameState, commitSynced]);

  // Reverts the field to whatever the server last confirmed. The discard
  // half of the pair: "leave the leaderboard exactly as it is."
  const discardName = useCallback(() => {
    setDisplayName(syncedName);
    setNameState((prev) => (prev === 'saving' || prev === 'loading' ? prev : 'ready'));
  }, [syncedName]);

  // Editing a name that ALREADY exists is the case that needs an explicit
  // commit: the leaderboard resolves profiles(display_name) live on every
  // fetch, so a rename is retroactive — it relabels every standing the
  // runner already has, not just future ones. Naming yourself for the FIRST
  // time (syncedName === '') has nothing to rewrite, so that path keeps the
  // frictionless save-on-blur it always had.
  const hasExistingName = syncedName.length > 0;
  const editable = nameState !== 'loading' && nameState !== 'saving';
  const showActions = hasExistingName && displayName !== syncedName;

  // Save-on-blur must NOT survive alongside the buttons: tapping either one
  // blurs the field first, so a blur that saves would commit the edit before
  // Discard could ever run — the exact thing the button is there to prevent.
  const saveOnBlur = useCallback(() => {
    if (hasExistingName) return;
    void saveName();
  }, [hasExistingName, saveName]);

  // A build with no server configured has no name that can save. Only the
  // LEADERBOARD section goes — not the page. It used to return an empty
  // SettingsPage, which was correct when the name was all this screen held;
  // now that would take the account controls and the diagnostics down with
  // it, and diagnostics is precisely what someone on a misconfigured build
  // needs to see. AccountLink already hides itself under the same condition,
  // so each section answers for itself.
  if (nameState === 'off') return null;

  // This section renders its own heading rather than being wrapped in one by
  // the page, because the page cannot know it is off — `nameState` lives
  // here. A Section wrapping a component that returned null would leave a
  // heading standing over nothing, which reads as a section that failed to
  // load rather than one that does not apply.
  return (
    <Section label={t('settings.sectionLeaderboard')} c={c}>
      <View style={settingsStyles.block}>
        <Text style={[settingsStyles.label, { color: c.textSecondary }]}>
          {t('settings.displayName')}
        </Text>
        <TextInput
          value={displayName}
          onChangeText={(next) => {
            setDisplayName(next);
            // 'off' is already impossible here — the screen returns early
            // above when the build has no server configured.
            if (nameState !== 'loading' && nameState !== 'saving') setNameState('ready');
          }}
          onBlur={saveOnBlur}
          onSubmitEditing={saveOnBlur}
          editable={editable}
          maxLength={DISPLAY_NAME_MAX}
          placeholder={t('settings.displayNamePlaceholder')}
          placeholderTextColor={c.textSecondary}
          returnKeyType="done"
          autoCapitalize="words"
          accessibilityLabel={t('settings.displayName')}
          style={[settingsStyles.input, { backgroundColor: c.backgroundElement, color: c.text }]}
        />
        <Text style={[
            settingsStyles.hint,
            {
              color:
                showActions || nameState === 'taken' || nameState === 'reserved'
                  ? c.accent
                  : c.textSecondary,
            },
          ]}>
          {nameState === 'failed'
            ? t('settings.displayNameFailed')
            : nameState === 'taken'
              ? t('settings.displayNameTaken')
              : nameState === 'reserved'
                ? t('settings.displayNameReserved')
                : nameState === 'saved'
                  ? t('settings.displayNameSaved')
                  : showActions
                    ? t('settings.displayNameDirtyHint')
                    : t('settings.displayNameHint')}
        </Text>
        {showActions && (
          <View style={styles.actions}>
            <Pressable
              onPress={() => void saveName()}
              disabled={!editable}
              accessibilityRole="button"
              hitSlop={10}
              style={[styles.saveButton, { backgroundColor: c.accent, opacity: editable ? 1 : 0.4 }]}>
              <Text style={styles.saveLabel}>{t('settings.displayNameSave')}</Text>
            </Pressable>
            <Pressable
              onPress={discardName}
              disabled={!editable}
              accessibilityRole="button"
              hitSlop={10}>
              <Text style={[styles.discardLabel, { color: c.textSecondary, opacity: editable ? 1 : 0.4 }]}>
                {t('settings.displayNameDiscard')}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </Section>
  );
}

/**
 * A labelled section of this page.
 *
 * Not index.tsx's GroupLabel/GroupBreak, though it speaks the same visual
 * language on purpose — that pair is tuned for a FULL-BLEED list of rows and
 * carries its own horizontal padding, while this sits inside SettingsPage's
 * already-padded content. Sharing one component would mean a padding prop
 * whose two values are "row list" and "content page", which is two
 * components wearing a trench coat. Kept local per settings-ui.tsx's own
 * rule: what one page uses stays in that page.
 */
function Section({
  label,
  c,
  children,
}: {
  label: string;
  c: Record<ThemeColor, string>;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>{label}</Text>
      {children}
    </View>
  );
}

export default function ProfileSettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();
  // The row leading here is already hidden on a build with no server (see
  // ./index.tsx's TERRITORY_ENABLED gate); this is the belt-and-braces for a
  // direct /settings/profile URL on web, carried over from the version of
  // this screen that held only the name field. Both components below hide
  // themselves under the same condition, but their HEADINGS would not.
  if (!TERRITORY_ENABLED) return <SettingsPage>{null}</SettingsPage>;
  return (
    <SettingsPage>
      <Section label={t('settings.accountTitle')} c={c}>
        <AccountLink c={c} />
      </Section>
      <Section label={t('settings.diagnosticTitle')} c={c}>
        <IdentityDiagnostic c={c} />
      </Section>
      <LeaderboardName />
    </SettingsPage>
  );
}

// Matches account-link.tsx's button language (filled accent pill for the
// commit, plain text for the way out) — the two forms sit on the same
// Settings surface and should not look like two different apps.
const styles = StyleSheet.create({
  section: { marginBottom: Spacing.five, gap: Spacing.two },
  // Matches index.tsx's groupLabel type scale so the two Settings surfaces
  // read as one app; the padding differs because the context does.
  sectionLabel: { fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.four, marginTop: Spacing.one },
  saveButton: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: 999,
  },
  saveLabel: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  discardLabel: { fontSize: 14, fontWeight: '600' },
});
