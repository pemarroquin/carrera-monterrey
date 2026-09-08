-- "This looks like an area that already exists."
--
-- Areas are public and anyone whose run touches one is ranked on it
-- automatically, which is what makes a Legend title mean something. The
-- failure mode that follows is NOT spam — creating an area wins nothing, so
-- there is no payoff to farm, unlike Strava where creating a segment on a
-- road you are fast on hands you a KOM. The failure mode is COLLISION: five
-- people naming the same park five ways. That costs nothing technically and
-- everything in meaning, because being Legend of one of five overlapping
-- areas is worth a fifth as much. The park stops having a champion.
--
-- So the fix is a nudge toward joining rather than a cap on making. A rate
-- limit would cap volume, and volume is not the problem — it would also
-- punish someone marking out four genuinely distinct loops in one evening.
--
-- Server-side because the cell list travels in a POST body. The client
-- alternative is `.in('h3', cells)`, which inlines every value in the URL —
-- an H3 id is ~16 characters, so a 600-cell area is a 10 KB request line.
--
-- APPLY BY HAND in the Supabase SQL editor.

begin;

-- Every existing area sharing ground with a proposed cell set, with enough
-- to judge HOW MUCH they share. `stable`, and it only reads — the caller
-- decides what counts as a duplicate, because that is a product threshold
-- and does not belong baked into SQL.
create or replace function area_overlaps(p_cells text[])
returns table (area_id uuid, name text, shared integer, area_cell_count integer)
language sql
stable
as $$
  select
    a.id,
    a.name,
    count(*)::integer                       as shared,
    -- The denominator for "how much of THEIR area does this cover", read
    -- from the areas row rather than counted: area_cells never changes after
    -- creation (there is no update policy), so the stored count cannot drift.
    a.cell_count                            as area_cell_count
  from area_cells c
  join areas a on a.id = c.area_id
  where c.h3 = any(p_cells)
  group by a.id, a.name, a.cell_count
  -- Most-shared first, so a caller taking only the top row gets the best
  -- match rather than an arbitrary one.
  order by shared desc;
$$;

commit;
