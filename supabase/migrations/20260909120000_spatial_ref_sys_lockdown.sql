-- Close anon write access to public.spatial_ref_sys.
--
-- APPLY BY HAND in the Supabase SQL editor. Nothing in this repo runs
-- migrations (see CLAUDE.md), and an unapplied one here reads as a security
-- advisory that never clears.
--
-- WHAT WAS FOUND, and it is not what the advisory email says.
--
-- Supabase's advisor reported `rls_disabled_in_public` on project
-- hkqwvzhoopoxocdtzgik with the standard wording: "Anyone with your project
-- URL can read, edit, and delete all data in this table". The table is
-- `spatial_ref_sys` — PostGIS's catalogue of coordinate systems, created in
-- `public` because the extension was installed there. Every one of this
-- app's own nine tables enforces RLS correctly; measured 2026-09-09 with the
-- anon key, each rejected an insert with 42501.
--
--     table              INSERT {}    verdict
--     runs               401 42501    RLS enforced
--     tile_visits        401 42501    RLS enforced
--     territory_tiles    401 42501    RLS enforced
--     territory_events   401 42501    RLS enforced
--     profiles           401 42501    RLS enforced
--     park_path_cells    401 42501    RLS enforced
--     park_path_stats    401 42501    RLS enforced
--     areas              401 42501    RLS enforced
--     area_cells         401 42501    RLS enforced
--     spatial_ref_sys    400 23502    *** nothing enforcing ***
--
-- 23502 is a not-null violation on `srid`. A COLUMN CONSTRAINT stopped that
-- insert, not a policy. UPDATE and DELETE through PostgREST both returned
-- 204 with the anon key. (Aimed at srid=999999, which does not exist, so
-- zero rows were touched — confirmed empty afterwards.)
--
-- SO THE REAL RISK IS INTEGRITY, NOT CONFIDENTIALITY. spatial_ref_sys holds
-- no user data: 8 500 rows of public EPSG definitions, byte-identical in
-- every PostGIS install on earth. Reading it discloses nothing. DELETING it
-- is the problem — drop SRID 4326 and every geography operation this app
-- performs fails, which takes Territory Mode down. That is a denial of
-- service reachable by anyone holding the anon key, and the anon key ships
-- in the web bundle by design.
--
-- WHY REVOKE RATHER THAN ENABLE RLS. spatial_ref_sys is owned by the PostGIS
-- extension, so `alter table ... enable row level security` needs an owner
-- this project's SQL editor may not be. It is attempted below anyway, inside
-- a block that survives failing, because if it does work it is the stronger
-- guarantee. The revoke is what actually closes the hole either way.
--
-- WHY NOT MOVE POSTGIS OUT OF public. That is Supabase's sanctioned way to
-- clear this advisory for good, and it is the wrong trade here: `runs.fence`
-- and `profiles.home_point` are geometry/geography columns whose TYPES live
-- in that schema, so moving the extension under a live app risks breaking
-- every one of them to silence a warning about a table with no user data in
-- it. Not worth it. The advisory may keep firing after this; the write
-- access it warns about will not exist.

begin;

-- The fix. Removes spatial_ref_sys from what PostgREST will serve these two
-- roles at all — no read, and crucially no UPDATE or DELETE.
--
-- Safe for the app's own PostGIS use: nothing here calls ST_Transform, the
-- function that reads this table to build a projection. Everything this app
-- does is geography-typed work at SRID 4326, which uses PostGIS's built-in
-- spheroid. Server-side functions that touch geometry either run
-- `security definer` (phase3_overlap) or operate on geography.
--
-- That reasoning is why this is safe, not proof that it is: verify it by
-- RECORDING AND UPLOADING A RUN after applying, not by the migration
-- applying cleanly. A function body that needs a privilege it no longer has
-- fails on first use, not at grant time.
revoke all on table public.spatial_ref_sys from anon, authenticated;

-- Defence in depth, and allowed to fail. Extension-owned tables usually
-- cannot be altered by the project role; when that is the case the revoke
-- above is the whole fix and this block records why nothing changed.
do $$
begin
  execute 'alter table public.spatial_ref_sys enable row level security';
  raise notice 'spatial_ref_sys: RLS enabled.';
exception
  when insufficient_privilege or wrong_object_type then
    raise notice 'spatial_ref_sys: not the owner, RLS left as-is. The revoke above is the fix.';
end;
$$;

commit;
