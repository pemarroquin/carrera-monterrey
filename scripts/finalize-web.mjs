// Post-processes the Expo web export so the deployed site has (a) working
// deep links and (b) something to show when a link is shared.
//
// THE DEEP-LINK PROBLEM
// `app.json` sets `web.output: "single"`, so `expo export -p web` emits ONE
// index.html and routes client-side from there. Porkbun's static hosting has
// no SPA rewrite, so a direct hit on /race/<id> — every link anyone shares,
// and every hard reload — returned 404. deploy/DEPLOY.md spells out why a
// global rewrite is the wrong lever (the static-hosting root is shared by
// every project subdomain) and notes the real requirement: "that needs a
// *specific* route's file to exist".
//
// So this writes that file. One `race/<id>/index.html` per race, each a copy
// of the SPA shell — which is all a static host needs to serve the route, and
// the client router takes it from there. The shell is ~1.4 KB and all its
// asset paths are root-absolute, so ~200 copies cost well under a megabyte
// and resolve identically from any depth.
//
// THE PREVIEW PROBLEM
// The export ships no description and no OpenGraph tags at all, so a shared
// link rendered as a bare URL and search engines had nothing to index. Since
// each race already gets its own file here, each one can carry its own real
// title and description rather than a single generic set.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { routeFilesIn, staticRoutesFrom } from './web-routes.mjs';

const DIST = path.resolve(process.argv[2] ?? 'dist');
const INDEX = path.join(DIST, 'index.html');
const RACES = path.resolve('assets/data/races.json');
const SITE_URL = 'https://runningapp.pmarroquin.com';
const APP_NAME = "Runners' Races MX";
const APP_DESCRIPTION =
  'Encuentra carreras de running en México: fechas, distancias, sedes y registro, en un solo lugar.';

/** Escape for use inside a double-quoted HTML attribute. */
const attr = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatDateEs(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS_ES[m - 1]} ${y}`;
}

/** One race's share/search description: when, where, how far. */
function describeRace(race) {
  const when = formatDateEs(race.date) ?? 'fecha por confirmar';
  const where = [race.city, race.state].filter(Boolean).join(', ');
  const distances = race.distances?.length ? ` · ${race.distances.join(' / ')}` : '';
  return `${when} · ${where}${distances}`;
}

/**
 * Replace the shell's <title> and inject preview tags before </head>.
 * Idempotent per output file — each call starts from the pristine shell.
 */
function withMeta(shell, { title, description, url }) {
  const tags = [
    `<meta name="description" content="${attr(description)}" />`,
    `<link rel="canonical" href="${attr(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${attr(APP_NAME)}" />`,
    `<meta property="og:title" content="${attr(title)}" />`,
    `<meta property="og:description" content="${attr(description)}" />`,
    `<meta property="og:url" content="${attr(url)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${attr(title)}" />`,
    `<meta name="twitter:description" content="${attr(description)}" />`,
  ].join('\n    ');

  return (
    shell
      // The export hardcodes lang="en"; the app's default locale is Spanish
      // and so is every string these tags carry.
      .replace('<html lang="en">', '<html lang="es">')
      .replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`)
      .replace('</head>', `  ${tags}\n  </head>`)
  );
}

const shell = readFileSync(INDEX, 'utf8');

// 1. The app root.
writeFileSync(
  INDEX,
  withMeta(shell, { title: APP_NAME, description: APP_DESCRIPTION, url: `${SITE_URL}/` }),
);

// 2. A generic fallback for hosts that serve 404.html on a miss.
//
//    Porkbun is NOT one of them, which this file used to claim it was. The
//    file deploys and /404.html returns 200, but a missing route still gets
//    openresty's own default error page — measured 2026-09-09, see
//    web-routes.mjs. So this is a courtesy for other hosts, never the
//    mechanism deep links rely on. Step 4 is that mechanism.
writeFileSync(
  path.join(DIST, '404.html'),
  withMeta(shell, { title: APP_NAME, description: APP_DESCRIPTION, url: `${SITE_URL}/` }),
);

// 3. One real file per race route.
const { races } = JSON.parse(readFileSync(RACES, 'utf8'));
let written = 0;
for (const race of races) {
  if (typeof race?.id !== 'string' || race.id === '') continue;
  const dir = path.join(DIST, 'race', race.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'index.html'),
    withMeta(shell, {
      title: `${race.name} — ${APP_NAME}`,
      description: describeRace(race),
      url: `${SITE_URL}/race/${race.id}`,
    }),
  );
  written += 1;
}

// 4. One real file per STATIC route, derived from the router's own directory.
//
//    This is what makes a hard reload work anywhere but the root. Until
//    2026-09-09 only race routes had files, so /races, /leaderboard and every
//    /settings/* page returned openresty's 404 on reload — reported as "it
//    happens often that whenever i try to reload the page in any mobile
//    browser in my cell i get a 404 Not Found error saying openresty".
//
//    Derived, never hand-listed: a hand-kept list is exactly how this bug
//    existed: races were enumerated and screens were not, so adding a screen
//    silently added a URL that 404s on reload. Nothing here needs touching
//    when a screen is added.
const routes = staticRoutesFrom(routeFilesIn(path.resolve('src/app')));
for (const route of routes) {
  const dir = path.join(DIST, route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'index.html'),
    withMeta(shell, {
      title: APP_NAME,
      description: APP_DESCRIPTION,
      url: `${SITE_URL}/${route}`,
    }),
  );
}

console.log(
  `finalize-web: meta on index.html + 404.html, ${routes.length} static routes, ${written} race routes`,
);
