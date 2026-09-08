// Nickname rules — the pure half of "no two runners share a name."
//
// This app has ONE name field and it is the identity: the leaderboard is a
// ranked list, so two runners called "Pedro" are indistinguishable exactly
// where it matters most. Uniqueness itself is enforced by the database
// (supabase/migrations/20260907120000_unique_display_name.sql) — the index
// is the rule, the same way territory_tiles' own constraints ARE the
// ownership model rather than something re-checked in TypeScript.
// This module only holds what can be decided WITHOUT a round trip: the
// handful of names nobody may take.
//
// Pure functions, no React, no network — same testing philosophy as
// tiles.ts and territory.ts.

/**
 * Names that stay unclaimable.
 *
 * Deliberately short. This is not a profanity filter (that needs a
 * maintained list and a review path, neither of which exists here) — it
 * blocks the two things that would actually break the leaderboard's
 * meaning:
 *
 *  1. The app's own word for "no name". A runner literally called
 *     "Anonymous" would be indistinguishable from every runner who never
 *     set one, which is the impersonation this whole change exists to stop.
 *     Both locales' placeholder, since either could be read as the real
 *     anonymous state (see i18n's displayNamePlaceholder).
 *  2. Names that imply the app is speaking. A row reading "Admin" or
 *     "Runners Races MX" on a public board carries authority nobody granted.
 */
export const RESERVED_NICKNAMES = [
  'anonymous',
  'anonimo',
  'admin',
  'administrator',
  'administrador',
  'moderator',
  'moderador',
  'support',
  'soporte',
  'runners races mx',
  'runners races',
  'runnersracesmx',
] as const;

/**
 * Normalizes for COMPARISON only — never for storage. Lowercases, strips
 * accents, and collapses runs of whitespace, so "Anónimo", "anonimo" and
 * "  ANÓNIMO  " all resolve to the same reserved word.
 *
 * Stricter than the database's own uniqueness index, which is a plain
 * lower() and therefore treats "Pédro" and "Pedro" as different names. That
 * asymmetry is deliberate and safe in this direction: the client refusing a
 * name the server would have allowed is a stricter gate, never a false
 * "available" that fails on save.
 */
export function normalizeNickname(name: string): string {
  return name
    .normalize('NFD')
    // Combining diacritical marks — the accents NFD just split off.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** True when nobody may take this name, whatever the database would allow. */
export function isReservedNickname(name: string): boolean {
  const normalized = normalizeNickname(name);
  return (RESERVED_NICKNAMES as readonly string[]).includes(normalized);
}
