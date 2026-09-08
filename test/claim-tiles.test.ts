// claimTiles — the client half of CONQUEST (territory-sync.ts +
// supabase/migrations/20260908010000_conquest.sql). Same reasoning as
// territory-sync-delete.test.ts's header: importing '@/lib/territory-sync'
// for real pulls in @supabase/supabase-js, which schedules an internal timer
// that throws under Node, so '@/lib/supabase' is mocked with a minimal
// stand-in for the exact call shapes claimTiles makes.
//
// Claiming moved server-side, so this file changed shape with it. It used to
// mock three client statements (insert visits, upsert tiles, read rivals);
// there is now one rpc() plus one read for the rival cell IDs. The ordering
// rule itself — "a tile only passes to a strictly newer run" — is SQL and is
// not covered here at all.
//
// What this does NOT cover: the claim function's own body, the plausibility
// trigger, the window and future-date checks, or the conditional upsert.
// Those exist only against a real Postgres and this suite is
// `environment: 'node'`. This proves claimTiles' TypeScript branching (how
// it reacts to what Postgres WOULD return) is correct, not that Postgres
// returns those shapes.
import { describe, expect, it, vi } from 'vitest';

let nextRpc: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let nextExisting: { h3: string; owner_id: string }[] | null = null;
let rpcCalls = 0;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (_fn: string, _args: unknown) => {
      rpcCalls++;
      return Promise.resolve(nextRpc);
    },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        in: (_col: string, _vals: string[]) => Promise.resolve({ data: nextExisting, error: null }),
      }),
    }),
  },
  ensureSession: async () => ({ user: { id: 'me' } }),
  TERRITORY_ENABLED: true,
}));

const { claimTiles } = await import('@/lib/territory-sync');

/** The function returns `returns table(...)`, which PostgREST delivers as an
 *  array of one row. */
const rpcOk = (claimed: number, taken: number, skipped_older: number) => ({
  data: [{ claimed, taken, skipped_older }],
  error: null,
});

describe('claimTiles', () => {
  it('returns an all-zero result for an empty cell list without touching the network', async () => {
    rpcCalls = 0;
    const outcome = await claimTiles('run-1', [], 'mty');
    expect(outcome).toEqual({
      ok: true,
      result: { claimedCount: 0, takenCount: 0, skippedOlder: 0, rivalTiles: 0, rivalRunners: 0, rivalCells: [] },
    });
    expect(rpcCalls).toBe(0);
  });

  it('passes the server counts straight through', async () => {
    nextRpc = rpcOk(2, 0, 0);
    nextExisting = null; // must not be read — nothing was skipped
    const outcome = await claimTiles('run-1', ['a', 'b'], 'mty');
    expect(outcome).toEqual({
      ok: true,
      result: { claimedCount: 2, takenCount: 0, skippedOlder: 0, rivalTiles: 0, rivalRunners: 0, rivalCells: [] },
    });
  });

  it('separates ground TAKEN off a rival from brand-new ground', async () => {
    // Conquest's whole point: winning a tile off someone is a different
    // achievement from claiming empty ground, and the summary says so.
    nextRpc = rpcOk(1, 3, 0);
    const outcome = await claimTiles('run-1', ['a', 'b', 'c', 'd'], 'mty');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.claimedCount).toBe(1);
    expect(outcome.result.takenCount).toBe(3);
  });

  it('reads rival cell IDs only when the run actually lost some ground', async () => {
    nextRpc = rpcOk(1, 0, 2);
    nextExisting = [
      { h3: 'b', owner_id: 'rival-1' },
      { h3: 'c', owner_id: 'rival-1' }, // one runner, two tiles
    ];
    const outcome = await claimTiles('run-1', ['a', 'b', 'c'], 'mty');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.skippedOlder).toBe(2);
    expect(outcome.result.rivalTiles).toBe(2);
    // Distinct owners, not rows — count people, not events.
    expect(outcome.result.rivalRunners).toBe(1);
    expect(outcome.result.rivalCells.sort()).toEqual(['b', 'c']);
  });

  it('never counts a tile this session already owns as a rival', async () => {
    nextRpc = rpcOk(1, 0, 1);
    nextExisting = [{ h3: 'b', owner_id: 'me' }];
    const outcome = await claimTiles('run-1', ['a', 'b'], 'mty');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.rivalTiles).toBe(0);
    expect(outcome.result.rivalCells).toEqual([]);
  });

  it('reports "rejected", not "network", when the forgery guard fires', () => {
    // The exact shape a plpgsql RAISE EXCEPTION comes back as through
    // PostgREST — an {error} carrying our own message, no thrown exception.
    nextRpc = {
      data: null,
      error: { message: 'TILE_FORGERY_GUARD: run run-1 has 9001 distinct claimed tiles total' },
    };
    return claimTiles('run-1', ['a'], 'mty').then((o) => expect(o).toEqual({ ok: false, reason: 'rejected' }));
  });

  it('reports "rejected" when the claim exceeds what the distance could enclose', () => {
    nextRpc = {
      data: null,
      error: { message: 'CLAIM_IMPLAUSIBLE: run run-1 claims 500000 tiles, above the bound of 900 for 1000m' },
    };
    return claimTiles('run-1', ['a'], 'mty').then((o) => expect(o).toEqual({ ok: false, reason: 'rejected' }));
  });

  it('reports "tooOld" — neither a bug nor an accusation — past the claim window', () => {
    // The runner did nothing wrong; the upload simply arrived too late to
    // compete. Collapsing this into 'network' would tell them to check their
    // connection, and into 'rejected' would imply they cheated.
    nextRpc = {
      data: null,
      error: { message: 'CLAIM_TOO_OLD: run run-1 ended 14:02:00 ago, past the 12:00:00 window' },
    };
    return claimTiles('run-1', ['a'], 'mty').then((o) => expect(o).toEqual({ ok: false, reason: 'tooOld' }));
  });

  it('reports "network" for any other claim failure', () => {
    nextRpc = { data: null, error: { message: 'connection refused' } };
    return claimTiles('run-1', ['a'], 'mty').then((o) => expect(o).toEqual({ ok: false, reason: 'network' }));
  });
});
