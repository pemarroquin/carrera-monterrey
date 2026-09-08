-- Park-path progress: the denominator, and the query that reads it.
--
-- WHY PARK PATHS AT ALL, measured rather than assumed. One 5.7 km run in San
-- Pedro Garza García is 0.262% of the municipio's AREA, 0.63% of its whole
-- street network, and 5.5% of its PARK PATHS. Only the last is a bar that
-- moves — the others are years or never. Park COUNT fails for a different
-- reason: 133 of San Pedro's 168 park polygons are under 1 ha, so counting
-- them measures traffic-island visits. Path length self-filters, an island
-- contributing ~0 km. That is the same conclusion Wandrer and CityStrides
-- each reached independently.
--
-- WHY A TABLE RATHER THAN A BUNDLED SEED, and the size is not the reason.
-- The dataset gzips to 88 KB, smaller than races.json — bundling was
-- affordable. It buys nothing: progress needs `tile_visits`, which lives
-- here, so the client cannot compute it offline whatever it ships with. A
-- bundled denominator would mean downloading 88 KB AND still making the
-- round trip. As a table it is one query, and it scales to all 51
-- municipios of Nuevo León rather than the seven the metro needs today.
--
-- APPLY BY HAND, then load the rows from the generated file (see below).

begin;

-- One row per cell of runnable path inside a park, attributed to exactly one
-- municipio. That exclusivity is load-bearing and was NOT free: Overpass's
-- `way(area)` returns ways that INTERSECT an area, so before clipping 8 866
-- of 47 345 cells (18.7%) belonged to two or three municipios at once — the
-- Río Santa Catarina linear park running along their shared boundaries.
-- Every denominator was inflated and one run would have credited a runner in
-- three municipios simultaneously. The extraction script now clips each cell
-- to the boundary that contains its centre; this table assumes that.
create table if not exists park_path_cells (
  municipio text not null,
  h3        text not null,
  primary key (municipio, h3)
);

-- The join direction that matters: given the cells a runner visited, which
-- park paths did they cover. Without this, progress scans the whole table.
create index if not exists park_path_cells_h3_idx on park_path_cells (h3);

-- Denominators and the headline numbers, one row per municipio. Stored
-- rather than counted so the UI can show "115.7 km of park path across 172
-- parks" without a second aggregate, and because km and park counts cannot
-- be derived from the cell table at all.
create table if not exists park_path_stats (
  municipio    text primary key,
  parks        integer not null,
  named_parks  integer not null,
  path_km      numeric not null,
  cells        integer not null,
  extracted_at timestamptz not null default now()
);

alter table park_path_cells enable row level security;
alter table park_path_stats enable row level security;

-- Read-only to every client. This is reference data extracted from OSM, not
-- anything a runner owns — there is deliberately no insert, update or delete
-- policy, so it can only be loaded by hand alongside a migration.
create policy "park_path_cells: read all" on park_path_cells for select using (true);
create policy "park_path_stats: read all" on park_path_stats for select using (true);

-- ============================================================================
-- Progress
-- ============================================================================
-- COUNTS VISITS, NOT ENCLOSURE, and that is the point of the split this app
-- already draws. Enclosure is how territory is won (Board 1); `tile_visits`
-- is where the runner actually went. Running a park's perimeter and claiming
-- its interior must not credit paths never run — progress is the exploration
-- record, not the game.
create or replace function municipio_progress()
returns table (municipio text, covered integer, total integer, path_km numeric, parks integer)
language sql
stable
as $$
  select
    s.municipio,
    coalesce(c.covered, 0)::integer,
    s.cells,
    s.path_km,
    s.parks
  from park_path_stats s
  left join (
    select p.municipio, count(distinct p.h3) as covered
    from park_path_cells p
    join tile_visits v on v.h3 = p.h3
    where v.user_id = auth.uid()
    group by p.municipio
  ) c on c.municipio = s.municipio
  -- Every municipio, including ones never run — a progress screen that hides
  -- the zeroes cannot show anyone where they have not been yet.
  order by coalesce(c.covered, 0) desc, s.municipio;
$$;

commit;
