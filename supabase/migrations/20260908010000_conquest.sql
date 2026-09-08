-- CONQUEST: territory can change hands. Owner's call, 2026-09-07/08.
--
-- Until now a tile belonged to whoever claimed it FIRST, permanently. That
-- made the most popular ground worthless to everyone but one person, which
-- is the opposite of what a running game wants. From here, a tile belongs to
-- whoever ran or surrounded it MOST RECENTLY.
--
-- APPLY BY HAND in the Supabase SQL editor, like every migration here
-- (nothing in this repo's tooling runs them — see CLAUDE.md). The client
-- change that calls claim_run_tiles() must NOT ship before this is applied:
-- the function will not exist and every claim will fail.
--
-- THIS MIGRATION REMOVES A SECURITY GUARANTEE, deliberately, and replaces it
-- with a weaker one. Read that part (section 2) before running it.

begin;

-- ============================================================================
-- 1. When a tile was claimed, by the RUN's clock
-- ============================================================================
-- `first_claimed_at` stays what it always was: the first time this ground was
-- ever taken, never rewritten, kept as history. `claimed_at` is new and is
-- the thing conquest compares — the ENDED_AT of the run that currently holds
-- the tile.
--
-- Why the run's clock and not the row's: an upload can arrive long after the
-- run. Laura runs at 10:00 and uploads at 12:30; David runs at 11:00 and
-- uploads at 11:05. Ordering by arrival would let Laura's late upload
-- overwrite David's NEWER run. Ordering by ended_at gives the tile to David,
-- who genuinely ran it last.
alter table territory_tiles add column if not exists claimed_at timestamptz;
update territory_tiles set claimed_at = first_claimed_at where claimed_at is null;
-- DEFAULT now() is load-bearing, not tidiness. The client that is deployed
-- while this is applied still inserts through the old path, which does not
-- send this column — without a default, NOT NULL rejects every one of those
-- inserts and territory stops being claimable the moment this migration
-- lands. now() is also the right value for that path: a run claiming
-- immediately after finishing has ended_at ~= now(). claim_run_tiles() below
-- always sets it explicitly from the run's own ended_at and never relies on
-- this.
alter table territory_tiles alter column claimed_at set default now();
alter table territory_tiles alter column claimed_at set not null;

create index if not exists territory_tiles_claimed_at_idx on territory_tiles (claimed_at);

-- ============================================================================
-- 2. Ownership becomes takeable — but only by a strictly newer run
-- ============================================================================
-- WHAT IS BEING GIVEN UP. enforce_territory_tiles_immutable() made an
-- already-owned tile physically unstealable: the RLS update policy is
-- deliberately permissive (any runner must be able to bump last_visited_at on
-- someone else's tile), and this trigger was the only thing stopping a plain
-- UPDATE from reassigning any tile to anyone. The anon key ships inside the
-- web bundle, so anyone can read it, create an anonymous session through the
-- API, and POST directly. Today that gets them nothing they do not already
-- own. After this migration it gets them a way in, bounded only by what
-- follows.
--
-- WHAT REPLACES IT. Three checks, in order of how much they actually buy:
--   a) A tile only changes hands to a STRICTLY NEWER run. Backdating cannot
--      take anything, so the only useful lie is a future date, which (3)
--      refuses outright.
--   b) h3 and first_claimed_at stay immutable. History is still append-only.
--   c) claim_run_tiles() bounds how much one run may claim (section 4).
--
-- WHAT IS STILL OPEN, stated plainly rather than implied: a forged run with a
-- plausible path, distance and recent timestamp can still take real ground.
-- Closing that needs the claimed cells recomputed server-side from
-- runs.raw_path and compared. Supabase offers an H3 extension for Postgres,
-- so that may be a plain trigger rather than the Edge Function the
-- tile-coverage migration originally scoped — CHECK before assuming. Not
-- built here.
create or replace function enforce_territory_tiles_immutable()
returns trigger
language plpgsql
as $$
begin
  -- Never rewritable, conquest or not.
  if new.h3 is distinct from old.h3
    or new.first_claimed_at is distinct from old.first_claimed_at
  then
    raise exception 'territory_tiles: h3 and first_claimed_at are immutable (h3=%)', old.h3;
  end if;

  -- A takeover must come from a strictly more recent run. `is distinct from`
  -- rather than <> so a null on either side cannot silently pass.
  if (new.owner_id is distinct from old.owner_id
      or new.claim_run_id is distinct from old.claim_run_id)
     and not (new.claimed_at > old.claimed_at)
  then
    raise exception
      'territory_tiles: ownership may only pass to a strictly newer run (h3=%, held by a run ending %, offered %)',
      old.h3, old.claimed_at, new.claimed_at;
  end if;

  return new;
end;
$$;

-- Trigger definition unchanged; only the body above moved. Recreated so
-- applying this file on a database where the trigger was dropped still ends
-- with the guard attached rather than silently unenforced.
drop trigger if exists territory_tiles_immutable on territory_tiles;
create trigger territory_tiles_immutable
  before update on territory_tiles
  for each row
  execute function enforce_territory_tiles_immutable();

-- ============================================================================
-- 3. Claiming, atomically and on the server's terms
-- ============================================================================
-- PostgREST's upsert cannot express "only overwrite if mine is newer", which
-- is the whole rule — so claiming moves into a function. That also puts the
-- window and bound checks somewhere the phone cannot argue with them.
--
-- security invoker (the default), NOT definer: RLS still applies, so a
-- runner can only ever write rows for their own session. The trigger above
-- enforces the ordering regardless of who calls this.
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
  -- How stale an upload may be and still claim territory, measured from the
  -- RUN's end, not the upload's arrival.
  --
  -- Pedro's first instinct was 3 hours. Widened here, and the reasoning is
  -- worth keeping: ordering by ended_at already makes a stale upload
  -- self-correcting — a two-day-old run automatically loses every tile
  -- anyone has run since, and can only take ground nobody has touched. It
  -- also kills run-hoarding, because an old run can never beat a newer one.
  -- So this window is not a safety mechanism, it is a product choice about
  -- whether a run you could not upload in time counts at all. 12 h covers a
  -- dead battery or a canyon with no signal while keeping the client clock
  -- pinned to a narrow band (see the future check below).
  -- CHANGE THIS ONE CONSTANT to move it; nothing else depends on the value.
  claim_window interval := interval '12 hours';
  -- Area of one res-12 H3 cell, m². A published H3 constant, same "known
  -- constant" approach as the tile edge length in the plausibility guard.
  tile_area_m2 constant numeric := 307.1;
  r            record;
  all_cells    text[];
  max_claimable integer;
  n_claimed    integer := 0;
  n_taken      integer := 0;
begin
  select id, user_id, ended_at, distance_m into r from runs where id = p_run_id;
  if r.id is null then
    raise exception 'CLAIM: no such run %', p_run_id;
  end if;
  if r.user_id <> auth.uid() then
    raise exception 'CLAIM: run % does not belong to the caller', p_run_id;
  end if;

  -- A run cannot finish in the future. Without this the whole ordering rule
  -- inverts into a weapon: ended_at comes from the phone, so a client could
  -- stamp a run in the year 3000 and hold those tiles against every real
  -- run forever. This is the single most important line in the file.
  if r.ended_at > now() then
    raise exception 'CLAIM: run % claims to end in the future (%)', p_run_id, r.ended_at;
  end if;

  if now() - r.ended_at > claim_window then
    raise exception 'CLAIM_TOO_OLD: run % ended % ago, past the % window', p_run_id, now() - r.ended_at, claim_window;
  end if;

  all_cells := array(select distinct unnest(coalesce(p_visited, '{}') || coalesce(p_enclosed, '{}')));

  -- Nothing to claim is a normal outcome (a run too short to cover a cell,
  -- or one whose every cell is already held by a newer run). Returning early
  -- keeps array_length's NULL-for-empty out of the arithmetic below.
  if coalesce(array_length(all_cells, 1), 0) = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  -- Bound on how much ONE run may claim. The hard geometric ceiling: no
  -- closed path encloses more area than a circle of the same perimeter, so
  -- for a run of distance d the enclosed area cannot exceed d^2/(4*pi). In
  -- tiles that is d^2/(4*pi*tile_area). Add the perimeter itself and a
  -- margin for tile granularity and GPS wander.
  --
  -- This does not catch a plausible forgery — a fabricated but realistic run
  -- passes. What it stops is scale: "claim half the city" cannot get through
  -- a legitimate-looking distance. A 10 km run is bounded near 39 000 tiles
  -- against a true maximum of about 25 900.
  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );
  if array_length(all_cells, 1) > max_claimable then
    raise exception 'CLAIM_IMPLAUSIBLE: run % claims % tiles, above the bound of % for %m',
      p_run_id, array_length(all_cells, 1), max_claimable, r.distance_m;
  end if;

  -- Ground actually crossed goes to the visit log, and ONLY that. Enclosed
  -- tiles are owned, never visited: the plausibility trigger on tile_visits
  -- bounds a run's tiles against its distance, and enclosure deliberately
  -- claims far more than the distance covers, so logging them there would
  -- reject every loop run outright.
  if coalesce(array_length(p_visited, 1), 0) > 0 then
    insert into tile_visits (h3, user_id, run_id)
    select unnest(p_visited), r.user_id, r.id
    on conflict (h3, run_id) do nothing;
  end if;

  -- The claim itself. `where excluded.claimed_at > territory_tiles.claimed_at`
  -- is the conquest rule in one line, and the trigger above enforces the same
  -- thing for anything that does not come through here.
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

  -- last_visited_at on every tile this run touched, including ones it did
  -- not win — the visit is real whatever the claim did.
  update territory_tiles set last_visited_at = now() where h3 = any(all_cells);

  -- skipped_older: cells this run touched but did NOT win, because the tile
  -- is already held by a run that finished later. Reported rather than
  -- swallowed — "you ran here and it is not yours" needs to be explainable.
  return query select
    coalesce(n_claimed, 0),
    coalesce(n_taken, 0),
    (array_length(all_cells, 1) - coalesce(n_claimed, 0) - coalesce(n_taken, 0))::integer;
end;
$$;

commit;
