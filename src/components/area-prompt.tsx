// "Name this area" — the only way an area (Board 2) comes into existence.
//
// Areas are made from RUNS rather than drawn on a map. That is not a
// shortcut: an area built from a run is ground somebody actually covered, at
// a real scale, which is exactly what makes it a fair contest. A drawing
// tool would let anyone outline a shape they have never been to.
//
// Offered only after a run that ENCLOSED ground, because a zone is a piece
// of ground worth returning to and a line is not that — see index.tsx's
// mount condition.
//
// Self-contained like NamePrompt: mount it and it decides the rest. It never
// blocks or delays the save it rides on top of.
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';

import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import {
  AREA_NAME_MAX,
  bestOverlap,
  createArea,
  findOverlappingAreas,
  isValidAreaName,
  type AreaOverlap,
} from '@/lib/areas';
import { useI18n } from '@/lib/i18n';

// 'skipped' is NOT 'done'. They were one state, and the result was that
// tapping "Not now" rendered "Area created. Come back tomorrow to defend
// it." — a success message for something that never happened, which is the
// one failure mode this codebase refuses (see the silent-success rule).
type Step =
  | 'ask'
  | 'checking' // looking for an existing area covering the same ground
  | 'overlap' // found one — offering to leave it alone
  | 'saving'
  | 'failed'
  | 'done'
  | 'skipped';

export function AreaPrompt({ cells, regionId }: { cells: string[]; regionId: string | null }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  const [step, setStep] = useState<Step>('ask');
  const [name, setName] = useState('');
  const [overlap, setOverlap] = useState<AreaOverlap | null>(null);

  const create = useCallback(async () => {
    setStep('saving');
    const outcome = await createArea(name, cells, regionId);
    // Honest failure — never close as if it worked. The name is still in the
    // field, so a retry costs nothing.
    setStep(outcome.ok ? 'done' : 'failed');
  }, [name, cells, regionId]);

  const save = useCallback(async () => {
    if (!isValidAreaName(name)) return; // the button is disabled too; belt and braces

    // Check for an area already covering this ground before creating a
    // second one on top of it. A failed check returns no overlaps, so being
    // unable to look never blocks someone naming their loop.
    setStep('checking');
    const match = bestOverlap(await findOverlappingAreas(cells));
    if (match) {
      setOverlap(match);
      setStep('overlap');
      return;
    }
    await create();
  }, [name, cells, create]);

  // Nothing was created, so say nothing.
  if (step === 'skipped') return null;

  if (step === 'done') {
    return (
      <Animated.View entering={FadeInDown.duration(320)}>
        <Text style={[styles.created, { color: c.accent }]}>{t('track.areaPromptCreated')}</Text>
      </Animated.View>
    );
  }

  if (step === 'overlap' && overlap) {
    return (
      <Animated.View entering={FadeInDown.duration(320)}>
        <GlassSurface scheme={scheme} radius={GlassRadii.card} contentStyle={styles.card}>
          <Text style={[styles.title, { color: c.text }]}>
            {t('track.areaOverlapTitle', { name: overlap.name })}
          </Text>
          {/* The point worth making plainly: joining costs NOTHING. Anyone
              whose run touches an area is ranked on it automatically, so
              accepting this suggestion means doing nothing at all. The
              button says so rather than offering a "join" that would imply
              an action the runner has not already taken. */}
          <Text style={[styles.body, { color: c.textSecondary }]}>{t('track.areaOverlapBody')}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => void create()} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.skip, { color: c.textSecondary }]}>{t('track.areaOverlapAnyway')}</Text>
            </Pressable>
            <Pressable
              onPress={() => setStep('skipped')}
              accessibilityRole="button"
              hitSlop={10}
              style={[styles.action, { backgroundColor: c.accent }]}>
              <Text style={styles.actionLabel}>{t('track.areaOverlapKeep')}</Text>
            </Pressable>
          </View>
        </GlassSurface>
      </Animated.View>
    );
  }

  const busy = step === 'saving' || step === 'checking';
  const canSave = isValidAreaName(name) && !busy;

  return (
    <Animated.View entering={FadeInDown.duration(320)} exiting={FadeOutUp.duration(200)}>
      <GlassSurface scheme={scheme} radius={GlassRadii.card} contentStyle={styles.card}>
        <Text style={[styles.title, { color: c.text }]}>{t('track.areaPromptTitle')}</Text>
        {/* The two facts worth knowing BEFORE committing: it is public, and
            it is permanent. Both are conditions of the game rather than fine
            print — an area only its creator knows about is one they win
            forever uncontested, and an area whose shape can move is not a
            fair contest at all. */}
        <Text style={[styles.body, { color: c.textSecondary }]}>{t('track.areaPromptBody')}</Text>

        <TextInput
          value={name}
          onChangeText={(next) => {
            setName(next);
            if (step === 'failed') setStep('ask');
          }}
          onSubmitEditing={() => {
            if (canSave) void save();
          }}
          editable={!busy}
          maxLength={AREA_NAME_MAX}
          placeholder={t('track.areaPromptPlaceholder')}
          placeholderTextColor={c.textSecondary}
          returnKeyType="done"
          autoCapitalize="words"
          accessibilityLabel={t('track.areaPromptTitle')}
          style={[styles.input, { backgroundColor: c.backgroundElement, color: c.text }]}
        />

        {step === 'failed' && (
          <Text style={[styles.error, { color: c.accent }]}>{t('track.areaPromptFailed')}</Text>
        )}

        <View style={styles.actions}>
          <Pressable onPress={() => setStep('skipped')} disabled={busy} accessibilityRole="button" hitSlop={10}>
            <Text style={[styles.skip, { color: c.textSecondary }]}>{t('track.areaPromptSkip')}</Text>
          </Pressable>
          <Pressable
            onPress={() => void save()}
            disabled={!canSave}
            accessibilityRole="button"
            hitSlop={10}
            style={[styles.action, { backgroundColor: c.accent, opacity: canSave ? 1 : 0.4 }]}>
            {busy && <ActivityIndicator color="#ffffff" style={styles.spinner} />}
            <Text style={styles.actionLabel}>
              {busy ? t('track.areaPromptSaving') : t('track.areaPromptSave')}
            </Text>
          </Pressable>
        </View>
      </GlassSurface>
    </Animated.View>
  );
}

// Same language as NamePrompt's card — the two ride the same surface at the
// same moment and should not look like two different apps.
const styles = StyleSheet.create({
  card: { gap: Spacing.two, padding: Spacing.three },
  title: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 18 },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  error: { fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  skip: { fontSize: 14, fontWeight: '600' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: 999,
  },
  actionLabel: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  spinner: { marginRight: Spacing.one },
  created: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
});
