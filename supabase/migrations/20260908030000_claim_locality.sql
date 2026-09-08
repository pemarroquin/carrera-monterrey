-- Claims must be NEAR THE RUN THAT CLAIMED THEM.
--
-- Conquest removed the guarantee that ownership cannot be stolen. What
-- replaced it (20260908010000) bounds SCALE — the isoperimetric ceiling, no
-- closed path encloses more than a circle of the same perimeter — but says
-- nothing about WHERE the claimed ground is. A forged upload with a
-- realistic distance can still claim tiles in a neighbourhood the runner
-- never went near, taking them off whoever actually runs there. That is
-- precisely the hole 20260903120000's own comment called out and left open:
-- "a TARGETED forgery that keeps a plausible cell COUNT for the claimed
-- distance but swaps in cell ids for ground the runner never went near
-- passes this check completely."
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not recompute the claimed
-- cells from raw_path and compare. That would mean reimplementing, in SQL,
-- the gap-closure budget (gap-policy.ts) and the enclosure fill
-- (enclosure.ts) — a second implementation of logic that already exists in
-- TypeScript. This repo has been burned by exactly that: gap-policy.ts only
-- exists because the recorder and the tile builder each applied the caps
-- themselves and disagreed about the same physical gap on a real run. Two
-- copies of enclosure would be that mistake at a much larger scale, and the
-- SQL copy would be the one nobody tests.
--
-- Instead it checks the one invariant that needs no shared logic: every
-- claimed cell must sit inside the bounding box of the path the run
-- actually recorded. Enclosure fills the INSIDE of a loop, gap bridging
-- draws a line between two recorded points, and privacy masking only ever
-- removes points — so every legitimate claim, of either kind, is inside
-- that box by construction. Cross-town claims are not.
--
-- APPLY BY HAND. Do NOT use `supabase db push` on this project — its
-- migration history lists nine already-applied migrations as pending.

begin;

-- REQUIRED. h3 is needed for exactly one function, h3_cell_to_lat_lng: this
-- migration has to turn a stored cell id back into a coordinate, and nothing
-- else in Postgres can. If this line fails, the extension is unavailable on
-- this project and the migration must not half-apply — that is why it is
-- here rather than inside a DO block that would quietly install a weaker
-- guard. A guard that reads as protection but is not is worse than none.
create extension if not exists h3 with schema extensions;

create or replace function claim_run_tiles(
  p_run_id  uuid,
  p_visited text[],
  p_enclosed text[],
  p_region  text
)
returns table (claimed integer, taken integer, skipped_older integer)
language plpgsql
as $$
declare
  claim_window interval := interval '12 hours';
  tile_area_m2 constant numeric := 307.1;
  -- Slack around the recorded path's bounding box, in degrees (~110 m of
  -- latitude). A cell is judged by its CENTRE, and a path clipping the edge
  -- of a boundary cell puts that centre just outside the box — this covers
  -- that without being loose enough to reach the next neighbourhood.
  bbox_margin  constant numeric := 0.001;
  r             record;
  all_cells     text[];
  max_claimable integer;
  min_lat numeric; max_lat numeric; min_lng numeric; max_lng numeric;
  outside_count integer;
  n_claimed     integer := 0;
  n_taken       integer := 0;
begin
  select id, user_id, ended_at, distance_m, raw_path into r from runs where id = p_run_id;
  if r.id is null then
    raise exception 'CLAIM: no such run %', p_run_id;
  end if;
  if r.user_id <> auth.uid() then
    raise exception 'CLAIM: run % does not belong to the caller', p_run_id;
  end if;
  -- A run cannot finish in the future. Without this the ordering rule
  -- inverts into a weapon: ended_at comes from the phone, so a client could
  -- stamp year 3000 and hold tiles against every real run forever.
  if r.ended_at > now() then
    raise exception 'CLAIM: run % claims to end in the future (%)', p_run_id, r.ended_at;
  end if;
  if now() - r.ended_at > claim_window then
    raise exception 'CLAIM_TOO_OLD: run % ended % ago, past the % window', p_run_id, now() - r.ended_at, claim_window;
  end if;

  all_cells := array(select distinct unnest(coalesce(p_visited, '{}') || coalesce(p_enclosed, '{}')));

  if coalesce(array_length(all_cells, 1), 0) = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );
  if array_length(all_cells, 1) > max_claimable then
    raise exception 'CLAIM_IMPLAUSIBLE: run % claims % tiles, above the bound of % for %m',
      p_run_id, array_length(all_cells, 1), max_claimable, r.distance_m;
  end if;

  -- ---------------------------------------------------------------------
  -- NEW: locality. raw_path is [[lat, lng, ts], ...] — element 0 is lat.
  -- ---------------------------------------------------------------------
  select
    min((e->>0)::numeric), max((e->>0)::numeric),
    min((e->>1)::numeric), max((e->>1)::numeric)
  into min_lat, max_lat, min_lng, max_lng
  from jsonb_array_elements(r.raw_path) e;

  -- A run with no usable path cannot justify any claim. Fails closed: this
  -- is the one branch where being generous means accepting cells with
  -- nothing at all to check them against.
  if min_lat is null then
    raise exception 'CLAIM_OFF_PATH: run % has no usable path to check its claim against', p_run_id;
  end if;

  select count(*) into outside_count
  from unnest(all_cells) as cell,
       lateral extensions.h3_cell_to_lat_lng(cell::extensions.h3index) as pt
  where pt.lat < min_lat - bbox_margin
     or pt.lat > max_lat + bbox_margin
     or pt.lng < min_lng - bbox_margin
     or pt.lng > max_lng + bbox_margin;

  if outside_count > 0 then
    raise exception 'CLAIM_OFF_PATH: run % claims % tiles outside the ground it recorded', p_run_id, outside_count;
  end if;

  -- Ground actually crossed goes to the visit log, and only that. Enclosed
  -- tiles are owned but never visited, so the plausibility trigger on
  -- tile_visits keeps bounding a run's tiles against its distance.
  if coalesce(array_length(p_visited, 1), 0) > 0 then
    insert into tile_visits (h3, user_id, run_id)
    select unnest(p_visited), r.user_id, r.id
    on conflict (h3, run_id) do nothing;
  end if;

  with upserted as (
    insert into territory_tiles as t (h3, owner_id, first_claimed_at, claim_run_id, claimed_at, last_visited_at, region_id)
    select unnest(all_cells), r.user_id, r.ended_at, r.id, r.ended_at, now(), p_region
    on conflict (h3) do update
      set owner_id        = excluded.owner_id,
          claim_run_id    = excluded.claim_run_id,
          claimed_at      = excluded.claimed_at,
          last_visited_at = now(),
          region_id       = coalesce(excluded.region_id, t.region_id)
      where excluded.claimed_at > t.claimed_at
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into n_claimed, n_taken
  from upserted;

  update territory_tiles set last_visited_at = now() where h3 = any(all_cells);

  return query select
    coalesce(n_claimed, 0),
    coalesce(n_taken, 0),
    (array_length(all_cells, 1) - coalesce(n_claimed, 0) - coalesce(n_taken, 0))::integer;
end;
$$;

commit;
