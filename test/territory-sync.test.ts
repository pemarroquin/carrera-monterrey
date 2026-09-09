// parseRawPath — turns raw_path (written on upload as `[lat, lng, ts]`
// triples, see uploadRun) back into LatLng[] for drawing the Saved tab's
// fence thumbnails with the actual recorded route instead of the fence
// polygon's boundary (the bug `1df2ae6` fixed for the summary map).
//
// Importing '@/lib/territory-sync' for real pulls in @supabase/supabase-js,
// which schedules an internal auto-refresh timer at client-construction time
// that later throws "window is not defined" under Node and fails the whole
// suite (an unhandled rejection, not caught by this file) — the same reason
// upload-queue.test.ts takes an injected Uploader instead of importing
// uploadRun directly. Mocking '@/lib/supabase' avoids ever constructing the
// real client while still exercising the actual parser.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {},
  ensureSession: async () => null,
  TERRITORY_ENABLED: false,
}));

const { groupVisitsByRun, parseRawPath } = await import('@/lib/territory-sync');

describe('parseRawPath', () => {
  it('parses valid [lat, lng, ts] triples into LatLng points', () => {
    const raw = [
      [25.67, -100.31, 1000],
      [25.671, -100.309, 2000],
    ];
    expect(parseRawPath(raw)).toEqual([
      { lat: 25.67, lng: -100.31 },
      { lat: 25.671, lng: -100.309 },
    ]);
  });

  it('accepts a JSON-text encoded array, the same recoverable case parseFenceGeometry handles', () => {
    const raw = JSON.stringify([[25.67, -100.31, 1000]]);
    expect(parseRawPath(raw)).toEqual([{ lat: 25.67, lng: -100.31 }]);
  });

  it('returns an empty array for an empty path rather than null', () => {
    expect(parseRawPath([])).toEqual([]);
  });

  it('returns null for null', () => {
    expect(parseRawPath(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseRawPath(undefined)).toBeNull();
  });

  it('returns null for malformed JSON text', () => {
    expect(parseRawPath('not json at all')).toBeNull();
  });

  it('returns null when the value is not an array at all', () => {
    expect(parseRawPath({ lat: 25.67, lng: -100.31 })).toBeNull();
  });

  it('returns null when an entry is missing a coordinate', () => {
    expect(parseRawPath([[25.67]])).toBeNull();
  });

  it('returns null when an entry is not itself an array', () => {
    expect(parseRawPath([{ lat: 25.67, lng: -100.31 }])).toBeNull();
  });

  it('returns null when a coordinate is not a number', () => {
    expect(parseRawPath([['25.67', '-100.31', 1000]])).toBeNull();
  });

  it('ignores a missing/non-numeric timestamp — only lat/lng are used', () => {
    expect(parseRawPath([[25.67, -100.31]])).toEqual([{ lat: 25.67, lng: -100.31 }]);
  });
});

// groupVisitsByRun — the shape "Where you've run" needs in order to apply
// enclosure PER RUN (the same rule a live session uses) rather than across
// the union of a runner's whole history. Every failure here is silent: two
// runs merged would enclose ground neither surrounded, a surviving res-11
// row would dissolve the set into nonsense rings.
describe('groupVisitsByRun', () => {
  // Real H3 indexes over Monterrey, not hand-written strings: isCurrentTileRes
  // calls h3-js's getResolution, which rejects anything that is not a valid
  // index — a made-up literal silently filters out and every assertion here
  // would pass against an empty result.
  // res 12, the resolution the app claims at.
  const A = '8c48a2062d835ff';
  const B = '8c48a2062d823ff';
  const C = '8c48a2062d9c9ff';
  // res 11, the pre-2026-09-07 resolution.
  const OLD = '8b48a2062d83fff';

  it('groups cells by run rather than flattening them', () => {
    const runs = groupVisitsByRun([
      { h3: A, run_id: 'r1' },
      { h3: B, run_id: 'r2' },
      { h3: C, run_id: 'r1' },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => [...r].sort())).toEqual(
      expect.arrayContaining([[A, C].sort(), [B]]),
    );
  });

  it('deduplicates a cell within one run — an out-and-back logs it twice', () => {
    expect(groupVisitsByRun([
      { h3: A, run_id: 'r1' },
      { h3: A, run_id: 'r1' },
    ])).toEqual([[A]]);
  });

  it('keeps a cell separately per run, because each run encloses on its own', () => {
    const runs = groupVisitsByRun([
      { h3: A, run_id: 'r1' },
      { h3: A, run_id: 'r2' },
    ]);
    expect(runs).toEqual([[A], [A]]);
  });

  it('drops cells at the old resolution instead of mixing two grids', () => {
    expect(groupVisitsByRun([
      { h3: A, run_id: 'r1' },
      { h3: OLD, run_id: 'r1' },
    ])).toEqual([[A]]);
  });

  it('omits a run entirely when every one of its cells was the old resolution', () => {
    expect(groupVisitsByRun([
      { h3: A, run_id: 'r1' },
      { h3: OLD, run_id: 'r2' },
    ])).toEqual([[A]]);
  });

  it('returns no runs for no rows, rather than one empty run', () => {
    expect(groupVisitsByRun([])).toEqual([]);
  });
});
