// Board 2's pure half: the ranking rule and the name gate. The scoring
// itself (one point per day present, trailing window) is SQL and is not
// covered here — this suite is environment:'node' with no Postgres.
//
// The ranking is duplicated between client and server deliberately, and
// that is exactly why it needs a test: if the two ever disagree, one runner
// shows as Legend on the list and another in the detail view.
import { describe, expect, it, vi } from 'vitest';

// '@/lib/areas' imports '@/lib/supabase' for its network functions, and
// importing that for real constructs a supabase-js client whose auth
// refresh timer reaches for `window` and throws under Node — same reason
// claim-tiles.test.ts and territory-sync-delete.test.ts mock it. Nothing
// under test here touches the network; the stub only has to exist.
vi.mock('@/lib/supabase', () => ({
  supabase: {},
  ensureSession: async () => ({ user: { id: 'me' } }),
  TERRITORY_ENABLED: true,
}));

const { AREA_DELETE_WINDOW_MS, AREA_NAME_MAX, canDeleteArea, isValidAreaName, rankLegends } =
  await import('@/lib/areas');

// Declared here rather than imported as a type: `await import` gives values,
// and a second type-only import of the same module would defeat the mock.
// The shape is small and asserted against the real function's behaviour.
interface LegendRow {
  userId: string;
  days: number;
  firstDay: string;
  displayName: string | null;
}

const row = (userId: string, days: number, firstDay: string): LegendRow => ({
  userId,
  days,
  firstDay,
  displayName: null,
});

describe('rankLegends', () => {
  it('ranks by days present, most first', () => {
    const ranked = rankLegends([row('a', 3, '2026-09-01'), row('b', 12, '2026-09-01'), row('c', 7, '2026-09-01')]);
    expect(ranked.map((r) => r.userId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie toward whoever has been at it longer', () => {
    // Defender's advantage without storing an incumbent: equal days go to
    // the earlier first day. Foursquare gives ties to the current holder,
    // which needs stored state that can drift; this is the same effect and
    // is deterministic.
    const ranked = rankLegends([row('newcomer', 10, '2026-09-05'), row('regular', 10, '2026-08-20')]);
    expect(ranked.map((r) => r.userId)).toEqual(['regular', 'newcomer']);
  });

  it('does not mutate its input', () => {
    const rows = [row('a', 1, '2026-09-01'), row('b', 9, '2026-09-01')];
    rankLegends(rows);
    expect(rows.map((r) => r.userId)).toEqual(['a', 'b']);
  });

  it('handles an empty board', () => {
    expect(rankLegends([])).toEqual([]);
  });

  it('a single huge day cannot outrank consistent attendance', () => {
    // The property the whole design rests on. One point per day however far
    // someone ran, so a mega-loop that touched this area once scores 1
    // against a runner who came 20 times. Without the cap, conquest and
    // enclosure would decide this board too.
    const megaLoop = row('david', 1, '2026-09-07');
    const regular = row('laura', 20, '2026-08-19');
    expect(rankLegends([megaLoop, regular])[0].userId).toBe('laura');
  });
});

describe('isValidAreaName', () => {
  it('accepts an ordinary name', () => {
    expect(isValidAreaName('Parque El Capitán')).toBe(true);
  });

  it('rejects empty or whitespace-only names', () => {
    // Names are permanent and public — there is no update policy on the
    // table — so this is the only chance to reject one.
    for (const name of ['', '   ', '\n\t']) expect(isValidAreaName(name), JSON.stringify(name)).toBe(false);
  });

  it('rejects a name past the length the database itself allows', () => {
    expect(isValidAreaName('x'.repeat(AREA_NAME_MAX))).toBe(true);
    expect(isValidAreaName('x'.repeat(AREA_NAME_MAX + 1))).toBe(false);
  });

  it('measures the TRIMMED name, matching the DB CHECK', () => {
    expect(isValidAreaName(`  ${'x'.repeat(AREA_NAME_MAX)}  `)).toBe(true);
  });
});

describe('canDeleteArea', () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.parse('2026-09-08T12:00:00Z');

  it('allows removing a mistake noticed straight away', () => {
    expect(canDeleteArea('2026-09-08T11:59:00Z', now)).toBe(true);
  });

  it('refuses once the window has passed', () => {
    // The case the window exists to refuse: abandoning a contested area days
    // later, once someone else has started winning it.
    expect(canDeleteArea('2026-09-08T10:59:00Z', now)).toBe(false);
    expect(canDeleteArea('2026-09-01T12:00:00Z', now)).toBe(false);
  });

  it('closes exactly on the hour, not after', () => {
    expect(canDeleteArea(new Date(now - HOUR + 1000).toISOString(), now)).toBe(true);
    expect(canDeleteArea(new Date(now - HOUR).toISOString(), now)).toBe(false);
  });

  it('matches the constant the RLS policy mirrors', () => {
    // If these drift, the UI offers a button the database refuses — which
    // surfaces as a silent no-op, since RLS makes a policy-less DELETE
    // return success having deleted nothing.
    expect(AREA_DELETE_WINDOW_MS).toBe(HOUR);
  });
});
