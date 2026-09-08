// Nicknames are unique app-wide (see nickname.ts and the display-name unique
// index). Uniqueness itself belongs to the database; what is testable here is
// the part decided without a round trip.
import { describe, expect, it } from 'vitest';

import { isReservedNickname, normalizeNickname, RESERVED_NICKNAMES } from '@/lib/nickname';

describe('normalizeNickname', () => {
  it('folds case', () => {
    expect(normalizeNickname('PEDRO')).toBe('pedro');
  });

  it('strips accents, so an accented spelling cannot slip past a reserved word', () => {
    expect(normalizeNickname('Anónimo')).toBe('anonimo');
    expect(normalizeNickname('José')).toBe('jose');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeNickname('  Pedro   Marroquin  ')).toBe('pedro marroquin');
  });

  it('leaves an ordinary name otherwise intact', () => {
    expect(normalizeNickname('Pedro Marroquin')).toBe('pedro marroquin');
  });
});

describe('isReservedNickname', () => {
  it('blocks the app’s own word for "no name", in both locales and any casing', () => {
    // The impersonation this whole change exists to stop: a runner literally
    // called "Anonymous" is indistinguishable from every runner who never set
    // a name (i18n's displayNamePlaceholder).
    for (const name of ['Anonymous', 'anonymous', 'ANONYMOUS', 'Anónimo', 'anonimo', ' Anónimo ']) {
      expect(isReservedNickname(name), name).toBe(true);
    }
  });

  it('blocks names that imply the app itself is speaking', () => {
    for (const name of ['Admin', 'moderador', 'Support', 'Runners Races MX']) {
      expect(isReservedNickname(name), name).toBe(true);
    }
  });

  it('allows ordinary names, including ones that merely contain a reserved word', () => {
    // Exact match only — "Administrador" is reserved, "Admin Pedro" is a
    // person's chosen name and blocking it would be a substring filter,
    // which is not what this is.
    for (const name of ['Pedro', 'Pedro Marroquin', 'Admin Pedro', 'anonymously fast']) {
      expect(isReservedNickname(name), name).toBe(false);
    }
  });

  it('every entry in the list is already normalized, or it could never match', () => {
    // A reserved word typed with a capital or an accent would compare against
    // a normalized input and never fire — the list would look protective and
    // do nothing.
    for (const entry of RESERVED_NICKNAMES) {
      expect(normalizeNickname(entry), entry).toBe(entry);
    }
  });
});
