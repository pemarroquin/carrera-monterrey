-- Unique leaderboard nicknames.
--
-- This app has ONE name field, and it is the only thing anyone would ever
-- search by — so it is the handle, not a display name. That is the Xbox
-- gamertag / Peloton leaderboard-username model, and it fits a
-- leaderboard-first product better than Instagram's or Strava's split into
-- unique @handle + non-unique display name (those exist for feeds, tagging
-- and profile URLs; none of which this app has). Owner's call, 2026-09-07.
--
-- Applied by hand in the Supabase SQL editor, like every other migration in
-- this directory (nothing in this repo's tooling runs them — see CLAUDE.md).
-- Until it IS applied, the client's "that nickname is taken" path simply
-- never fires and duplicates stay possible; it fails open, not closed.

-- Case-insensitive: without lower(), "Pedro" and "pedro" both exist and the
-- impersonation hole this closes is reopened by the shift key.
--
-- PARTIAL (where display_name is not null) for the reason the column is
-- nullable in the first place: null means "show me as Anonymous", which is
-- the shared, deliberately non-unique state. A plain unique index would let
-- exactly ONE runner in the whole app be anonymous and fail everyone else's
-- very first upload.
--
-- Empty string is excluded too. updateDisplayName() already stores '' as
-- null, but nothing at the DB level guaranteed that before this migration,
-- and a stray '' row would occupy the same "nameless" slot under a
-- different value.
create unique index if not exists profiles_display_name_unique_idx
  on profiles (lower(display_name))
  where display_name is not null and display_name <> '';
