import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keyset, toPage } from '../src/lib/pagination.js';
import { escapeLike, insertSql, SqlParams, updateSql } from '../src/lib/sql.js';

describe('sql helpers', () => {
  it('insertSql writes only whitelisted, defined columns', () => {
    const sql = insertSql('person', ['display_name', 'is_living'], {
      display_name: 'Augustine',
      is_living: null,
      created_by: 'x',
      'evil; DROP TABLE x': 1,
      year_from: undefined,
    });
    expect(sql.text).toBe('INSERT INTO person (display_name, is_living) VALUES ($1, $2) RETURNING id');
    expect(sql.values).toEqual(['Augustine', null]);
  });

  it('updateSql returns null when nothing is whitelisted', () => {
    expect(updateSql('person', ['display_name'], { created_by: 'x' }, { id: 'a' })).toBeNull();
    const sql = updateSql('person', ['display_name', 'date_note'], { date_note: 'c. 400' }, { id: 'a' })!;
    expect(sql.text).toBe('UPDATE person SET date_note = $1 WHERE id = $2 RETURNING id');
    expect(sql.values).toEqual(['c. 400', 'a']);
  });

  it('rejects unsafe identifiers from code', () => {
    expect(() => insertSql('person; --', ['a'], { a: 1 })).toThrow(/unsafe/);
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

describe('pagination helpers', () => {
  const id = '0190a000-0000-7000-8000-000000000001';

  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    expect(() => decodeCursor('bm90LWEtdXVpZA')).toThrow(/invalid cursor/);
    expect(decodeCursor(encodeCursor(42), (k) => /^\d+$/.test(k))).toBe('42');
  });

  it('keyset adds a condition only with a cursor and fetches one extra row', () => {
    const p = new SqlParams();
    const page = keyset(p, { limit: 2, cursor: encodeCursor(id) }, 't.id');
    expect(page.where).toEqual(['t.id > $1']);
    expect(page.limitSql).toBe('LIMIT $2');
    expect(p.values).toEqual([id, 3]);
    expect(keyset(new SqlParams(), {}, 'id')).toMatchObject({ where: [], limit: 50 });
  });

  it('toPage trims the extra row and sets next_cursor', () => {
    expect(toPage([{ id: 'a' }], 1)).toEqual({ items: [{ id: 'a' }], next_cursor: null });
    const page = toPage([{ id: id }, { id: 'b' }], 1);
    expect(page.items).toEqual([{ id }]);
    expect(decodeCursor(page.next_cursor!)).toBe(id);
  });
});
