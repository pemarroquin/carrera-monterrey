// BOARD 2 — Local Leaders. Mayorship over ground you keep coming back to.
//
// Board 1 (conquest, see leaderboard.ts) answers "who holds this ground right
// now" and changes hands the moment somebody else runs there. This answers
// the other question — "who actually runs here" — and cannot be taken with a
// single visit. Pedro's example is the spec: Daniel runs his local park 365
// days, a rival runs it 362, Daniel holds it. One point per DAY, so a rival
// cannot buy the title with one enormous Sunday.
//
// WHAT REPLACED AREAS, and why this file exists at all. Board 2 used to rank
// user-created `areas`: a runner closed a loop, was asked to NAME it, and
// became its Legend. That was rejected outright — "why are we naming loops
// and shit" — and the rejection was right for a reason beyond taste: the
// runner who draws the shape is the only one who knows it exists, so they
// draw it around their own daily route and hold it uncontested. (The backlog
// spotted that risk and answered it by requiring shapes to be public, which
// still leaves someone inventing and naming a place.)
//
// The unit is now THE GRID ITSELF. Mayorship is per H3 cell, decided by days
// present. Nothing is declared, named, or drawn:
//
//   - Daniel's park works, because his route covers those cells every day.
//   - "Some street block near my house" works identically, with no special
//     case, no polygon and no name — the ask that settled this design.
//   - Areas EMERGE. Contiguous cells you are mayor of dissolve into one
//     shape (cellsToMultiPolygon, as everywhere else in this codebase), so
//     "your turf" is drawn from what you actually run rather than declared
//     in advance.
//
// PURE, on rows already fetched — same philosophy as leaderboard.ts and
// territory.ts, and the reason this suite (`environment: 'node'`, no
// renderer, no Postgres) can cover the mechanic completely.
import { districtOfCell } from '@/lib/district';

/**
 * Trailing window for the title, in days. Foursquare's mayorship uses 30 and
 * it is a period a runner can actually feel: long enough that one week off
 * does not erase you, short enough that the title has to be defended.
 *
 * Moved here from areas.ts (as LEGEND_WINDOW_DAYS) when areas were deleted.
 * The constant survived its own feature because the MECHANIC survived — only
 * the unit it applies to changed, from a named shape to a cell.
 */
export const MAYORSHIP_WINDOW_DAYS = 30;

/** One recorded visit to one cell. `tile_visits` is append-only, which is
 *  what makes days-present countable at all — conquest rewrites ownership
 *  but never rewrites history. */
export interface TileVisitRow {
  h3: string;
  userId: string;
  displayName: string | null;
  /** ISO timestamp, as stored (`visited_at`). */
  visitedAt: string;
}

export interface MayorshipEntry {
  userId: string;
  displayName: string | null;
  /** Cells this runner is mayor of. THE score for this board. */
  cellsHeld: number;
  /** Their best single-cell day count in the window — the "365" in Pedro's
   *  example. Shown next to the score so the number means something
   *  concrete; never ranked by, or a runner with one heavily-run cell would
   *  outrank someone who is mayor of a whole neighbourhood. */
  bestDays: number;
}

/**
 * UTC calendar day of a timestamp.
 *
 * UTC, not local, and this is a real decision rather than laziness: the
 * window is compared against days derived the same way on every device, so a
 * runner crossing a timezone cannot gain or lose a day, and two runners in
 * different zones are counted on one clock. The cost is that a run starting
 * at 18:30 local in Monterrey (UTC-6) lands on the NEXT UTC day — which
 * matters not at all for "how many distinct days did you show up", since
 * every run is attributed consistently.
 */
function dayKey(iso: string): string {
  // No defensive ternary here, deliberately. An earlier version read
  // `iso.slice(0, 10) === '' ? iso : …`, which LOOKS like a guard against a
  // bad timestamp and only catches the empty string — anything else
  // unparseable still reaches toISOString() and throws RangeError. Documenting
  // a safety that does not exist is worse than none, because the next caller
  // trusts it.
  //
  // The real guard is in mayorByCell, which drops any row whose time is NaN
  // before this is ever reached. Callers must keep that contract.
  return new Date(iso).toISOString().slice(0, 10);
}

/** Milliseconds in the trailing window. */
const WINDOW_MS = MAYORSHIP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface CellClaim {
  days: Set<string>;
  /** Earliest visit in the window, for the incumbency tie-break. */
  firstMs: number;
}

/**
 * Who is mayor of each cell, from raw visits.
 *
 * Ties go to the INCUMBENT — whoever got there first inside the window.
 * That is Foursquare's own rule and the backlog already settled it for this
 * app: without it the title flips every week between two equally regular
 * runners, and a title that flips on noise is not worth defending. A rival
 * who draws level does not take it; they have to go one day better.
 *
 * Visits outside the window are ignored, not clamped — a cell nobody has run
 * in 30 days has no mayor, which is the decay this board is supposed to
 * have.
 */
export function mayorByCell(
  visits: TileVisitRow[],
  now: number = Date.now(),
): Map<string, { userId: string; days: number }> {
  const cutoff = now - WINDOW_MS;
  // cell -> user -> claim
  const cells = new Map<string, Map<string, CellClaim>>();

  for (const visit of visits) {
    const ms = new Date(visit.visitedAt).getTime();
    // NaN from an unparseable timestamp fails BOTH comparisons, so a bad row
    // is dropped rather than counted as "now" — a silently-recent visit
    // would hand someone a title they never earned.
    if (!(ms >= cutoff) || !(ms <= now)) continue;

    let byUser = cells.get(visit.h3);
    if (!byUser) {
      byUser = new Map();
      cells.set(visit.h3, byUser);
    }
    const claim = byUser.get(visit.userId);
    if (claim) {
      claim.days.add(dayKey(visit.visitedAt));
      if (ms < claim.firstMs) claim.firstMs = ms;
    } else {
      byUser.set(visit.userId, { days: new Set([dayKey(visit.visitedAt)]), firstMs: ms });
    }
  }

  const mayors = new Map<string, { userId: string; days: number }>();
  for (const [h3, byUser] of cells) {
    let bestUser: string | null = null;
    let bestDays = 0;
    let bestFirstMs = Infinity;
    for (const [userId, claim] of byUser) {
      const days = claim.days.size;
      const wins =
        days > bestDays ||
        // The incumbency rule. On equal days the earlier arrival keeps it;
        // the final userId comparison is only there so the answer does not
        // depend on Map iteration order for two runners who also arrived on
        // the same millisecond.
        (days === bestDays &&
          (claim.firstMs < bestFirstMs ||
            (claim.firstMs === bestFirstMs && (bestUser === null || userId < bestUser))));
      if (wins) {
        bestUser = userId;
        bestDays = days;
        bestFirstMs = claim.firstMs;
      }
    }
    if (bestUser !== null) mayors.set(h3, { userId: bestUser, days: bestDays });
  }
  return mayors;
}

/**
 * The board: runners ranked by how many cells they are mayor of.
 *
 * `district` scopes it to one arena (pass null for everywhere). Scoping
 * happens on the CELL, before mayorship is decided, so a district's board is
 * decided entirely by ground inside it — a rival's devotion to a park across
 * town cannot place them here.
 */
export function rankMayors(
  visits: TileVisitRow[],
  district: string | null,
  now: number = Date.now(),
): MayorshipEntry[] {
  const scoped =
    district === null ? visits : visits.filter((v) => districtOfCell(v.h3) === district);
  const mayors = mayorByCell(scoped, now);

  const nameById = new Map<string, string | null>();
  for (const visit of scoped) {
    // First non-null wins — a partial profile join leaves some rows null,
    // same "the count is the point, the name is a garnish" posture as
    // rankByTileCount.
    if (nameById.get(visit.userId) == null && visit.displayName !== null) {
      nameById.set(visit.userId, visit.displayName);
    } else if (!nameById.has(visit.userId)) {
      nameById.set(visit.userId, null);
    }
  }

  const byUser = new Map<string, { cellsHeld: number; bestDays: number }>();
  for (const { userId, days } of mayors.values()) {
    const entry = byUser.get(userId);
    if (entry) {
      entry.cellsHeld++;
      if (days > entry.bestDays) entry.bestDays = days;
    } else {
      byUser.set(userId, { cellsHeld: 1, bestDays: days });
    }
  }

  return [...byUser.entries()]
    .map(([userId, agg]) => ({
      userId,
      displayName: nameById.get(userId) ?? null,
      cellsHeld: agg.cellsHeld,
      bestDays: agg.bestDays,
    }))
    // Cells held, then best-days, then id — a total order, so the board does
    // not reshuffle between loads on ties.
    .sort(
      (a, b) =>
        b.cellsHeld - a.cellsHeld ||
        b.bestDays - a.bestDays ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
}

/** The cells one runner is mayor of, for drawing their turf on the map. */
export function cellsHeldBy(
  mayors: Map<string, { userId: string; days: number }>,
  userId: string,
): string[] {
  const held: string[] = [];
  for (const [h3, mayor] of mayors) if (mayor.userId === userId) held.push(h3);
  return held;
}

/**
 * Ground you hold but somebody else runs more often — your territory at
 * RISK.
 *
 * This is the one number that ties the two boards together, and it is the
 * reason they belong on one screen rather than behind a toggle. Board 1 says
 * you own a cell (you ran it most recently). Board 2 says someone else is
 * there far more. Both are true at once, and together they say something
 * neither says alone: you are about to lose this.
 *
 * Cells with no mayor are NOT contested — nobody has been there inside the
 * window, so there is no one to lose them to. Cells you are mayor of are
 * likewise safe by definition.
 */
export function contestedCells(
  ownedCells: string[],
  mayors: Map<string, { userId: string; days: number }>,
  userId: string,
): string[] {
  const atRisk: string[] = [];
  for (const h3 of ownedCells) {
    const mayor = mayors.get(h3);
    if (mayor && mayor.userId !== userId) atRisk.push(h3);
  }
  return atRisk;
}
