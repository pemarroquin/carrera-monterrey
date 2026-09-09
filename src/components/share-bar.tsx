// Who holds this district, as one bar.
//
// This is what replaced the leaderboard's card list as the thing you look at
// first ("having leaderboard with only cards is boring and i do not like it
// at all"). A ranked list answers "what position am I in"; a share bar
// answers "how much of this place is anybody's", which is the actual
// question a territory game is about — and it answers it at a glance,
// without reading a single number.
//
// It also works at ONE runner, which a podium or a card list does not. A
// board with a single row reads as an empty app; a bar reading "you 0.8%,
// unclaimed 99.2%" reads as a game with 99.2% left to take. That is the
// state this app is actually in today, so it is the state the design has to
// flatter.
import { StyleSheet, Text, View } from 'react-native';

import type { ThemeColor } from '@/constants/theme';
import { Spacing } from '@/constants/theme';

export interface ShareSegment {
  key: string;
  /** 0-1. Segments need not sum to 1 — see `unclaimedLabel`. */
  share: number;
  color: string;
  label: string;
  isMe: boolean;
}

/**
 * Minimum rendered width of a segment, in px.
 *
 * This replaced a MIN_VISIBLE_SHARE of 0.02 that folded any sub-2% runner
 * into an anonymous grey "others" block — which was exactly backwards. The
 * sub-2% case is not an edge case here, it is the NORMAL early state, and it
 * is the state this component's header says it exists to serve ("you 0.8%,
 * unclaimed 99.2%"). With one runner at 0.8% the bar rendered no tinted
 * segment at all: their colour, their name, their percentage and the isMe
 * ring all vanished and the first-run state read as "Others 0.8%".
 *
 * A floor on WIDTH keeps proportions honest for large shares while keeping
 * small ones legible, instead of deciding some runners do not get drawn. The
 * distortion it introduces is bounded and only matters with many runners in
 * one district — at which point every share is large enough not to need it.
 */
const MIN_SEGMENT_PX = 8;

export function ShareBar({
  segments,
  c,
  unclaimedLabel,
}: {
  segments: ShareSegment[];
  c: Record<ThemeColor, string>;
  /** Rendered for whatever is left over. Null hides the remainder entirely,
   *  for a bar whose segments already sum to 1 (the mayorship bar, where
   *  every held cell has exactly one holder). */
  unclaimedLabel: string | null;
}) {
  // Only a genuinely empty share is dropped — someone holding nothing is not
  // a slice of anything. Everyone else is drawn, however small.
  const visible = segments.filter((s) => s.share > 0);
  const claimed = visible.reduce((sum, s) => sum + s.share, 0);
  // Clamped, because floating-point sums of many shares can land a hair over
  // 1 and a negative flex would throw the layout away.
  const remainder = Math.max(0, 1 - claimed);

  return (
    <View style={styles.wrap}>
      <View style={[styles.track, { backgroundColor: c.backgroundElement }]}>
        {visible.map((segment) => (
          <View
            key={segment.key}
            style={[
              styles.segment,
              {
                flexGrow: segment.share,
                minWidth: MIN_SEGMENT_PX,
                backgroundColor: segment.color,
                // Your own slice is the one you look for. A ring rather than
                // a different colour, so the per-runner colour still keys to
                // the rows below.
                borderWidth: segment.isMe ? 2 : 0,
                borderColor: c.text,
              },
            ]}
          />
        ))}
        {unclaimedLabel !== null && remainder > 0 && (
          <View style={[styles.segment, { flexGrow: remainder }]} />
        )}
      </View>

      <View style={styles.keys}>
        {visible.map((segment) => (
          <Key key={segment.key} color={segment.color} text={segment.label} c={c} />
        ))}
        {unclaimedLabel !== null && remainder > 0 && (
          <Key color={c.backgroundElement} text={unclaimedLabel} c={c} />
        )}
      </View>
    </View>
  );
}

function Key({
  color,
  text,
  c,
}: {
  color: string;
  text: string;
  c: Record<ThemeColor, string>;
}) {
  return (
    <View style={styles.key}>
      <View style={[styles.keyDot, { backgroundColor: color }]} />
      <Text style={[styles.keyText, { color: c.textSecondary }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.two },
  track: {
    flexDirection: 'row',
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
  },
  // flexBasis 0 so flexGrow alone decides the width — with the default
  // `auto` basis an empty View still claims content width and every segment
  // would render the same size regardless of its share.
  segment: { flexBasis: 0, height: '100%' },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  key: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  keyDot: { width: 8, height: 8, borderRadius: 4 },
  keyText: { fontSize: 12, fontWeight: '600' },
});
