// One ranked row, shared by both boards.
//
// ONE component for two boards, and the shape is what keeps them from being
// mistaken for each other: every row states its own UNIT (`% of park paths`
// vs `cells · best 22 days`). The old screen kept the two boards behind a
// toggle specifically so two incomparable numbers could not look like one
// ranking — a real concern, answered here by labelling instead of hiding, so
// both can be on one screen and the navigation collapses to nothing.
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import type { ThemeColor } from '@/constants/theme';
import { Spacing } from '@/constants/theme';

export function BoardRow({
  rank,
  name,
  /** The big right-hand number, already formatted with its unit. */
  score,
  /** The quiet line under the name — what the score is made of. */
  detail,
  tint,
  isMe,
  /** Rendered as a warning chip. Flagged claims still COUNT (same
   *  "marked, not punished" posture as every board here); the row says so
   *  rather than the score quietly excluding them. */
  flaggedLabel,
  c,
}: {
  rank: number;
  name: string;
  score: string;
  detail: string;
  tint: string;
  isMe: boolean;
  flaggedLabel?: string;
  c: Record<ThemeColor, string>;
}) {
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: isMe ? c.backgroundSelected : c.backgroundElement },
        // Your own row carries the same ring as your slice of the share bar,
        // so the two read as one object seen twice.
        isMe && { borderWidth: 1.5, borderColor: c.text },
      ]}>
      <Text style={[styles.rank, { color: c.textSecondary }]}>{rank}</Text>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <View style={styles.names}>
        <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.detailRow}>
          <Text style={[styles.detail, { color: c.textSecondary }]} numberOfLines={1}>
            {detail}
          </Text>
          {flaggedLabel !== undefined && (
            <>
              <Icon ios="exclamationmark.triangle.fill" android="warning" size={10} color={c.accent} />
              <Text style={[styles.detail, { color: c.accent }]}>{flaggedLabel}</Text>
            </>
          )}
        </View>
      </View>
      <Text style={[styles.score, { color: c.text }]}>{score}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
  rank: { fontSize: 15, fontWeight: '700', minWidth: 22, fontVariant: ['tabular-nums'] },
  dot: { width: 10, height: 10, borderRadius: 5 },
  names: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '700' },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detail: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  score: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
