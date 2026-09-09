// The deep-link fix: `web.output: "single"` emits ONE index.html, and
// Porkbun's static hosting serves files by path with no SPA rewrite, so any
// URL without a real file behind it returns openresty's 404 — on every hard
// reload and every shared link. Measured against the live site on
// 2026-09-09: / was 200, /races /leaderboard /settings/location all 404,
// while /race/<id> was 200 because those files were being written.
//
// So these pin the enumeration that writes the rest. The failure mode is
// silent and only shows up on a phone, on the deployed site, after a reload
// — nothing in tsc, lint or the export can see it.
import { describe, expect, it } from 'vitest';

// Plain .mjs build script, imported for its pure route derivation exactly as
// scripts/finalize-web.mjs does — one implementation, so a test cannot pass
// against a copy that has drifted from what the build actually writes.
import { routeFilesIn, staticRoutesFrom } from '../scripts/web-routes.mjs';

describe('staticRoutesFrom', () => {
  it('strips route groups, which never appear in the URL', () => {
    // (tabs)/races.tsx serves at /races — the group is a folder for layout,
    // not a path segment. Emitting "(tabs)/races" would write a directory
    // literally named "(tabs)" that nothing ever requests.
    expect(staticRoutesFrom(['(tabs)/races.tsx'])).toEqual(['races']);
  });

  it('resolves index.tsx to its parent directory', () => {
    expect(staticRoutesFrom(['(tabs)/settings/index.tsx'])).toEqual(['settings']);
  });

  it('excludes the app root, which is already dist/index.html', () => {
    expect(staticRoutesFrom(['(tabs)/index.tsx'])).toEqual([]);
  });

  it('excludes _layout.tsx, which is not a route', () => {
    expect(staticRoutesFrom(['(tabs)/_layout.tsx'])).toEqual([]);
  });

  it('excludes dynamic routes, which are enumerated from data instead', () => {
    // A file cannot be written for a URL unknown until someone asks for it.
    // finalize-web.mjs writes race/<id>/index.html per race; a literal
    // "[id]" directory would be a URL nobody can reach.
    expect(staticRoutesFrom(['race/[id].tsx'])).toEqual([]);
  });

  it('collapses a .web.tsx variant onto the same route, not a second one', () => {
    expect(staticRoutesFrom(['(tabs)/races.tsx', '(tabs)/races.web.tsx'])).toEqual(['races']);
  });

  it('is sorted, so the build artifact is stable between machines', () => {
    const routes = staticRoutesFrom(['(tabs)/races.tsx', '(tabs)/leaderboard.tsx']);
    expect(routes).toEqual([...routes].sort());
  });
});

describe('the real app', () => {
  const routes: string[] = staticRoutesFrom(routeFilesIn('src/app'));

  it('covers every screen that had no file before this fix', () => {
    // The exact URLs reported as 404ing on reload.
    expect(routes).toEqual(
      expect.arrayContaining([
        'races',
        'leaderboard',
        'myraces',
        'settings',
        'settings/location',
        'settings/privacy',
        'settings/profile',
      ]),
    );
  });

  it('never emits a group, a layout or a dynamic segment', () => {
    for (const route of routes) {
      expect(route).not.toContain('(');
      expect(route).not.toContain('[');
      expect(route).not.toContain('_layout');
      expect(route.endsWith('/index')).toBe(false);
    }
  });

  it('finds routes at all — an empty list would deploy silently', () => {
    // Guards the walk itself. If routeFilesIn ever returned nothing (a moved
    // app directory, a changed extension), every assertion above would pass
    // vacuously and the deploy would go back to 404ing with nothing to say.
    expect(routes.length).toBeGreaterThan(5);
  });
});
