// Which URLs the deployed site must have a REAL FILE for.
//
// `app.json` sets `web.output: "single"`, so `expo export -p web` emits one
// index.html and routes everything else client-side. Porkbun's static
// hosting (openresty) serves files by path and has no SPA rewrite, so any
// URL without a file behind it returns openresty's own 404 — on every hard
// reload and every shared link.
//
// MEASURED 2026-09-09, against the live site:
//
//     /                                200
//     /races                           404  (openresty's default error page)
//     /settings/location               404
//     /leaderboard                     404
//     /404.html                        200  <- the file is deployed
//     /race/verano-monterrey-2026      200  (301 -> trailing slash)
//
// Two things follow, and the second one contradicts what deploy/DEPLOY.md
// said. Porkbun does NOT serve 404.html as its error document: the file is
// right there, reachable, and a missing route still gets openresty's default
// page instead. The "catch-all for any client-side route this script doesn't
// enumerate" never fired. What DOES work is the mechanism the race routes
// already used — a real file at the URL — which is why /race/<id> was the
// one deep link that survived a reload.
//
// So every static route gets a file, and this derives them from the router's
// own directory rather than a hand-kept list. A hand-kept list is how
// /settings/location came to 404 while /race/<id> did not: races were
// enumerated, screens were not, and adding a screen silently added a broken
// URL. Nothing here needs updating when a screen is added.
import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every file under `dir`, as paths relative to it. Sorted so the output is
 * stable between machines — readdir order is not guaranteed, and an unstable
 * build artifact is a diff nobody can read.
 */
export function routeFilesIn(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.name.endsWith('.tsx')) out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Router file paths → the URL paths that need a file, root excluded.
 *
 * Expo Router's conventions, and each exclusion is a route that must NOT get
 * one:
 *
 *   _layout.tsx      not a route at all — it wraps them.
 *   (group)/         a grouping folder; it never appears in the URL, which
 *                    is why (tabs)/races.tsx serves at /races.
 *   [id].tsx         dynamic. A file cannot be written for a URL that is not
 *                    known until someone asks for it, so these are enumerated
 *                    from data instead (see finalize-web.mjs's race routes).
 *                    Emitting a literal "[id]" directory would create a URL
 *                    nobody can reach.
 *   index.tsx        resolves to its parent directory: settings/index.tsx is
 *                    /settings, and the app root is already dist/index.html.
 *
 * `.web.tsx` platform variants collapse onto the same route as their base
 * file, so they are dropped rather than emitted twice.
 */
export function staticRoutesFrom(files) {
  const routes = new Set();
  for (const file of files) {
    const name = path.basename(file);
    if (name === '_layout.tsx') continue;
    if (file.includes('[')) continue;

    const segments = file
      .replace(/\.web\.tsx$/, '')
      .replace(/\.tsx$/, '')
      .split('/')
      .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));

    if (segments[segments.length - 1] === 'index') segments.pop();
    const route = segments.join('/');
    if (route !== '') routes.add(route);
  }
  return [...routes].sort();
}
