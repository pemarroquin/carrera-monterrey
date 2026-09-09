// "Which account is this device actually signed in as, and what does the
// server return for it?" — answered on screen, in copyable text.
//
// WHY THIS EXISTS. Territory Mode's entire data model hangs off one value
// nothing on screen ever showed: `session.user.id`. Every symptom of that
// value being wrong looks identical to having no data — an empty
// Territories map, an empty leaderboard, a "you haven't captured anything
// yet" line — and none of them distinguish "you are the wrong user" from
// "this user genuinely has nothing" from "the query failed". Diagnosing it
// has meant cross-referencing Supabase's admin API against phone
// screenshots, repeatedly, over hours. This row makes the same check take
// ten seconds: the id, the email, and the raw outcome of the very query
// the Territories tab runs — fetchMyFences(), not a re-implementation of
// it, so what this reports and what that screen draws can never disagree.
//
// Deliberately always visible rather than hidden behind a long-press like
// settings.tsx's last-run debug copy. A hidden diagnostic is only useful
// to someone who already knows it is there; the whole point here is to be
// findable when a runner writes in to say their territory vanished. It
// stays small, muted and last in its section so it reads as a footnote.
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Spacing, type ThemeColor } from '@/constants/theme';
import { onIdentityChanged } from '@/lib/auth-events';
import { useI18n } from '@/lib/i18n';
import { ensureSession, TERRITORY_ENABLED } from '@/lib/supabase';
import { fetchMyFences } from '@/lib/territory-sync';
import { listQueued } from '@/lib/upload-queue';

interface Report {
  /** Null when there is no session at all — ensureSession() failed, which
   *  is itself the answer to "why is everything empty". */
  userId: string | null;
  /** Null on an anonymous session. Not an error: it is the app's default
   *  state until a runner links an email. */
  email: string | null;
  /** Rows fetchMyFences() actually returned, or null when the call failed
   *  — `reason` carries which failure. Zero and "failed" must never render
   *  as the same thing; that conflation is the bug this whole file exists
   *  to end. */
  fenceCount: number | null;
  /** Rows the server returned that could not be parsed (a present-but
   *  -unreadable fence, or a bad timestamp) — see fetchMyFences' `skipped`.
   *  A non-zero value here with a zero count means the data IS there and
   *  the client is dropping it, which is a completely different bug from
   *  an identity mismatch. */
  skipped: number;
  reason: string | null;
  /** Runs still sitting in the local retry queue (upload-queue.ts) — the
   *  third place a "missing" territory can legitimately be. */
  queued: number;
  checkedAt: number;
}

async function buildReport(): Promise<Report> {
  const session = await ensureSession();
  const outcome = await fetchMyFences();
  return {
    userId: session?.user.id ?? null,
    email: session?.user.email ?? null,
    fenceCount: outcome.ok ? outcome.fences.length : null,
    skipped: outcome.ok ? outcome.skipped : 0,
    reason: outcome.ok ? null : outcome.reason,
    queued: listQueued().length,
    checkedAt: Date.now(),
  };
}

export function IdentityDiagnostic({ c }: { c: Record<ThemeColor, string> }) {
  const { t } = useI18n();
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    setCopied(false);
    const next = await buildReport();
    setReport(next);
    setBusy(false);
  }, []);

  // Runs on mount and again whenever the identity swaps — the one moment
  // this is most worth re-reading, and the moment a runner is most likely
  // to be looking at it.
  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);

  useEffect(() => {
    let stale = false;
    const id = setTimeout(() => {
      buildReport().then((next) => {
        if (!stale) setReport(next);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [identitySignal]);

  const copy = useCallback(async () => {
    if (!report) return;
    await Clipboard.setStringAsync(JSON.stringify(report, null, 2));
    setCopied(true);
  }, [report]);

  // A build with no Supabase configured has no identity to report and
  // never will — the row would only ever say "disabled", which is noise.
  if (!TERRITORY_ENABLED) return null;

  const territories = !report
    ? '…'
    : report.reason !== null
      ? t('settings.diagnosticFailed', { reason: report.reason })
      : String(report.fenceCount ?? 0);

  return (
    <View style={styles.block}>
      {/* No title of its own any more: this is a SECTION of the Profile page
          (2026-09-09) and that page supplies the heading, from the same
          `settings.diagnosticTitle` key. Rendering both put the word
          "Diagnostics" on screen twice, in two different type scales. */}
      <Text style={[styles.hint, { color: c.textSecondary }]}>{t('settings.diagnosticBody')}</Text>

      <Row label={t('settings.diagnosticSession')} c={c}>
        {/* selectable so the id can be pulled out on web without the copy
            button, where a long-press gesture is awkward */}
        <Text selectable style={[styles.mono, { color: c.text }]}>
          {report ? (report.userId ?? t('settings.diagnosticNoSession')) : '…'}
        </Text>
      </Row>

      <Row label={t('settings.diagnosticEmail')} c={c}>
        <Text selectable style={[styles.value, { color: c.text }]}>
          {report ? (report.email ?? t('settings.diagnosticAnonymous')) : '…'}
        </Text>
      </Row>

      <Row label={t('settings.diagnosticTerritories')} c={c}>
        <Text style={[styles.value, { color: c.text }]}>
          {territories}
          {report && report.skipped > 0
            ? ` ${t('settings.diagnosticSkipped', { count: report.skipped })}`
            : ''}
        </Text>
      </Row>

      {report && report.queued > 0 && (
        <Row label={t('settings.diagnosticQueued')} c={c}>
          <Text style={[styles.value, { color: c.text }]}>{report.queued}</Text>
        </Row>
      )}

      <View style={styles.actions}>
        <Pressable onPress={() => void check()} disabled={busy} accessibilityRole="button" hitSlop={10}>
          <Text style={[styles.action, { color: c.accent, opacity: busy ? 0.5 : 1 }]}>
            {busy ? t('settings.diagnosticChecking') : t('settings.diagnosticRecheck')}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void copy()}
          disabled={!report}
          accessibilityRole="button"
          hitSlop={10}>
          <Text style={[styles.action, { color: c.accent, opacity: report ? 1 : 0.5 }]}>
            {copied ? t('settings.diagnosticCopied') : t('settings.diagnosticCopy')}
          </Text>
        </Pressable>
        {busy && <ActivityIndicator color={c.textSecondary} />}
      </View>
    </View>
  );
}

function Row({
  label,
  c,
  children,
}: {
  label: string;
  c: Record<ThemeColor, string>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: c.textSecondary }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Spacing.one, marginTop: Spacing.three },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: Spacing.one },
  row: { gap: 1 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  value: { fontSize: 13 },
  // fontFamily left to the platform default rather than pinned to a mono
  // face: constants/theme.ts's Fonts.mono is iOS-only ('ui-monospace'), and
  // a missing family silently falls back anyway — the id is selectable,
  // which is what actually matters for reading it back.
  mono: { fontSize: 12, lineHeight: 16 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.four, marginTop: Spacing.two },
  action: { fontSize: 13, fontWeight: '600' },
});
