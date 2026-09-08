-- Re-bounds the tile forgery guard for H3 resolution 12.
--
-- DEFAULT_TILE_RES changed from 11 (~28.7 m edge, ~2,150 m² per tile) to 12
-- (~10.8 m, ~307 m²) on 2026-09-07 — the owner's call, after being shown
-- that H3 resolutions step by a fixed factor of 7 in area, so the "15x
-- smaller" he asked for does not exist.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT CLAIMS AT RES 12.
--
-- Not a nicety. check_tile_visit_plausibility bounds a run's claimed tile
-- count using a hard-coded tile edge length. While that constant still says
-- 25 m, a res-12 upload is measured against a bound computed for tiles 7x
-- larger, and a normal run can exceed it — which does not degrade, it
-- RAISES, and the whole run save fails. (This repo has already shipped that
-- exact failure once: "HOTFIX: the p90 trigger broke every run upload".)
-- Applied first, this is merely more generous to res-11 uploads, which
-- breaks nothing. The order is only dangerous in one direction.
--
-- Applied by hand in the Supabase SQL editor, like every other migration
-- here (nothing in this repo's tooling runs them — see CLAUDE.md).
--
-- The DATA half of this change — converting already-claimed tiles — is
-- generated separately by `npm run convert-tile-res` into
-- supabase/generated/ (gitignored: it is a one-off backfill of live rows,
-- regenerable at any time, and committing it would write one person's
-- location history into git permanently). Apply this file first, that one
-- second.

-- Identical to 20260903120000_tile_coverage.sql's function except for the
-- two constants that are a function of tile SIZE. Reproduced in full rather
-- than patched, because `create or replace function` has no other form.
--
-- Measured, not assumed. test/fixtures' three real recorded paths, replayed
-- through the app's own pathToTiles at res 12, against this new bound:
--
--   real 5,945 m run    281 cells vs bound 1,653   5.88x headroom
--   drive 3,299 m       179 cells vs bound   918   5.13x
--   drive 3,404 m       173 cells vs bound   948   5.48x
--
-- And it still catches what it was built to catch: the 3.3 km one-way path
-- that auto-closed into a 977,565 m² fence is ~3,184 res-12 cells
-- (977,565 / ~307 m² each) against a bound of 918 — REJECTED by more than
-- 3x. The guard did not get weaker in exchange for not false-rejecting.
create or replace function check_tile_visit_plausibility()
returns trigger
language plpgsql
as $$
declare
  -- Res-12 edge length (~10.8 m), from H3's published cell statistics — the
  -- same "known constant" approach as the 25 m res-11 value it replaces.
  tile_edge_m constant numeric := 10.8;
  -- Unchanged at 3x. See the measured headroom above: still generous for
  -- real route geometry, still far below a fabricated claim.
  safety_multiplier constant numeric := 3;
  -- Raised from 8 alongside the resolution. This floor exists so a
  -- near-stationary run is not judged on distance alone, and the ground a
  -- standing runner's GPS jitter covers is now ~7 smaller tiles rather than
  -- 1. One cell plus two rings of neighbours is 19; 24 leaves margin.
  min_allowed_tiles constant integer := 24;
  r record;
  run_distance_m numeric;
  cnt integer;
  max_allowed integer;
begin
  -- Unchanged from the original: cumulative distinct-h3 count per run_id
  -- across every tile_visits row for it, not just this batch's, so a
  -- deliberately-chunked upload cannot bypass the cap.
  for r in select distinct run_id from new_rows
  loop
    select distance_m into run_distance_m from runs where id = r.run_id;
    -- No matching run or no recorded distance: fail closed.
    if run_distance_m is null then
      raise exception 'TILE_FORGERY_GUARD: run % has no distance_m; cannot validate submitted tiles', r.run_id;
    end if;

    select count(distinct h3) into cnt from tile_visits where run_id = r.run_id;
    max_allowed := greatest(min_allowed_tiles, ceil(run_distance_m / tile_edge_m) * safety_multiplier)::integer;

    if cnt > max_allowed then
      raise exception 'TILE_FORGERY_GUARD: run % has % distinct claimed tiles total, which exceeds the plausible bound of % for a %sm run (edge %sm, x% margin)',
        r.run_id, cnt, max_allowed, run_distance_m, tile_edge_m, safety_multiplier;
    end if;
  end loop;
  return null; -- ignored for an AFTER STATEMENT trigger
end;
$$;

-- The trigger itself is unchanged and still bound to the same function name
-- (20260903120000_tile_coverage.sql created it); replacing the function body
-- is enough. Recreated here anyway so applying this file out of order, on a
-- database where that trigger was somehow dropped, still leaves the guard
-- attached rather than silently unenforced.
drop trigger if exists tile_visits_plausibility_guard on tile_visits;
create trigger tile_visits_plausibility_guard
  after insert on tile_visits
  referencing new table as new_rows
  for each statement
  execute function check_tile_visit_plausibility();
