-- Let a creator remove an area they just made — briefly.
--
-- 20260908020000 gave `areas` no delete policy at all, deliberately: an area
-- whose shape or existence a losing incumbent can remove is not a contest.
-- That reasoning is right and stands. It was over-applied: it also made a
-- typo, a test, or a mis-named loop permanent and public forever, with no
-- way back. The first area anyone creates is the one most likely to be a
-- mistake.
--
-- THE WINDOW IS WHAT SEPARATES THE TWO CASES. A mistake is noticed within
-- minutes. Rage-quitting a contested area happens days or weeks later, once
-- someone else has started winning it. One hour admits the first and refuses
-- the second, and it needs no extra state — `created_at` already exists.
--
-- Deliberately NOT "delete while nobody else has scored there". That sounds
-- more precise and is worse: it stays open indefinitely, so the moment a
-- rival's first run lands the area becomes permanent — which means a
-- creator watching for a challenger can delete the instant one appears, and
-- an area nobody has found yet can be deleted a year later. Time since
-- creation is the honest axis.
--
-- APPLY BY HAND in the Supabase SQL editor.

begin;

create policy "areas: delete own within the window" on areas
  for delete using (
    auth.uid() = created_by
    and created_at > now() - interval '1 hour'
  );

-- area_cells has an ON DELETE CASCADE to areas, so removing the area takes
-- its cells with it — but the cascade runs as the DELETING user and RLS
-- still applies to the cascaded rows. Without this the delete above fails
-- for any area that actually has cells, which is all of them.
--
-- Scoped through the parent exactly as the insert policy is, so a cell can
-- only ever be removed by way of removing the area that owns it.
create policy "area_cells: delete with own area" on area_cells
  for delete using (
    exists (
      select 1 from areas a
      where a.id = area_id
        and a.created_by = auth.uid()
        and a.created_at > now() - interval '1 hour'
    )
  );

commit;
