-- AREAS + LOCAL LEGENDS (Board 2). Decided 2026-09-07/08 with Pedro.
--
-- Board 1 (territory) rewards big loops, planning and recency, and swings
-- around: one huge Sunday run can top it. That is correct and should stay.
-- What it cannot do is reward the runner who goes to the same park five
-- times a week, which is most runners most of the time.
--
-- Strava hit this exactly. One all-time champion per segment left everyone
-- else with nothing to play for, so they added Local Legend — most EFFORTS
-- in a rolling window, not the fastest. Same split here, and the important
-- part is WHERE the fix lives: three earlier attempts to protect the regular
-- runner inside the ownership rules all made the map worse (see the backlog
-- spec's three recorded corrections). Ownership stays simple; fairness for
-- regulars gets its own scoreboard.
--
-- APPLY BY HAND in the Supabase SQL editor. Nothing in this repo's tooling
-- runs migrations (see CLAUDE.md), and `supabase db push` is currently
-- UNSAFE on this project: its migration history table lists nine migrations
-- as unapplied that were in fact applied by hand, so a push would re-run
-- them and abort on `create policy` statements that already exist.

begin;

-- ============================================================================
-- 1. An area is a named, PUBLIC piece of ground
-- ============================================================================
-- No OSM park boundaries, deliberately — Pedro's call, and it drops a large
-- dependency. An area can be a park, a street block, or any shape a runner
-- decides is worth competing over.
--
-- PUBLIC is the condition that makes the title mean anything. If the runner
-- who creates an area is the only one who knows it exists, they draw it
-- around their own daily route and are its Legend forever, uncontested. So
-- every area is readable by everyone and anyone whose run touches it is
-- ranked on it automatically, exactly like a Strava segment. The known cost
-- is duplicate/near-identical areas, which eventually needs dedup rules —
-- Strava has the same problem and has never fully solved it.
create table if not exists areas (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 40),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  -- Same coarse metro string as runs.region / territory_tiles.region_id, so
  -- the areas near a runner can be found without a spatial query.
  region_id  text,
  -- Denominator for "how much of this area do you hold" and a cheap size
  -- read. Kept as a column rather than counted every time: area_cells never
  -- changes after creation (see below).
  cell_count integer not null default 0
);

create index if not exists areas_region_idx on areas (region_id);

-- The shape, as the H3 cells it covers, at the app's own tile resolution.
-- A cell list rather than a PostGIS polygon on purpose: every question this
-- table has to answer is "did this run touch this area", which is a set
-- intersection against tile_visits.h3 — an indexed join, no spatial
-- operators and no H3 extension needed.
--
-- IMMUTABLE after creation. An area whose shape can move is not a fair
-- contest: whoever owns it could reshape it around their own route whenever
-- they started losing. There is deliberately no update policy below.
create table if not exists area_cells (
  area_id uuid not null references areas(id) on delete cascade,
  h3      text not null,
  primary key (area_id, h3)
);

-- The join direction that matters: given the cells a run visited, which
-- areas did it touch. Without this the legend query scans every area's cells.
create index if not exists area_cells_h3_idx on area_cells (h3);

alter table areas enable row level security;
alter table area_cells enable row level security;

create policy "areas: read all" on areas for select using (true);
create policy "areas: insert own" on areas for insert with check (auth.uid() = created_by);
-- No update and no delete policy, for either table: an area's name and shape
-- are fixed once other runners have started competing on it. Removing one is
-- an admin action, not something a losing incumbent can do.
create policy "area_cells: read all" on area_cells for select using (true);
create policy "area_cells: insert own" on area_cells
  for insert with check (
    exists (select 1 from areas a where a.id = area_id and a.created_by = auth.uid())
  );

-- ============================================================================
-- 2. Local Legend: most DAYS present in the trailing window
-- ============================================================================
-- One point per day, however far the runner went that day. That cap is the
-- whole mechanic, and it is what the games that stay fun have in common:
-- Foursquare counts one check-in per day, Strava counts efforts rather than
-- distance, Pokemon GO allows one Pokemon per gym. Ingress is the
-- counter-example — its scoring DOES scale with area, and large-field play
-- dominating the board is its best-known complaint.
--
-- Without the cap, conquest and enclosure would decide this board too: one
-- 10 km loop enclosing ~25,900 tiles across several parks would beat a
-- runner who covered 300 tiles a day for a month (9,000). The mega-looper
-- would win every area at once, from a single outing, without entering any
-- of them.
--
-- ATTENDANCE READS tile_visits, NOT territory_tiles. Ground you SURROUNDED
-- is owned but was never run over, and this board is about showing up — so
-- circling a park from outside cannot make you its Legend, while running its
-- normal path does automatically. This is NOT the rejected "you must run
-- inside the park" rule: ownership is untouched here, David can still take
-- the park's tiles from outside. He just cannot be its Legend without going.
create or replace function area_legends(p_area_id uuid, p_days integer default 30)
returns table (user_id uuid, days integer, first_day date)
language sql
stable
as $$
  select
    v.user_id,
    count(distinct (v.visited_at at time zone 'UTC')::date)::integer as days,
    min((v.visited_at at time zone 'UTC')::date)                     as first_day
  from tile_visits v
  join area_cells c on c.h3 = v.h3
  where c.area_id = p_area_id
    and v.visited_at > now() - make_interval(days => p_days)
  group by v.user_id
  -- Ties go to whoever has been at it longer. Foursquare gives ties to the
  -- incumbent, which needs the current holder stored and kept up to date;
  -- earliest first day is the same defender's advantage with no stored state
  -- to drift, and it is deterministic rather than depending on when the
  -- query happens to run.
  order by days desc, first_day asc;
$$;

commit;
