import { describe, expect, it } from 'vitest';
import { buildCreate, buildDelete, buildList, buildUpdate, checksumExpr, escapeLike } from '../src/db/sql.js';
import type { EntityDef } from '../src/types.js';

const entity: EntityDef = {
  name: 'widget',
  label: 'Widgets',
  table: 'widget',
  key: ['code'],
  fields: [
    { name: 'code', label: 'Code', type: 'string', required: true },
    { name: 'description', label: 'Description', type: 'string' },
    { name: 'price', label: 'Price', type: 'number' },
    { name: 'launch_date', label: 'Launch', type: 'date' },
  ],
};
const T = '`c`.`s`.`widget`';

describe('sql builders', () => {
  it('list filters the current version and binds search with ! escape', () => {
    const { sql, countSql, params } = buildList(entity, T, { page: 2, pageSize: 10, search: '50%_off', dir: 'desc' });
    expect(sql).toContain('is_current = true');
    expect(countSql).toContain('is_current = true');
    expect(sql).toContain("LIKE :search ESCAPE '!'");
    expect(params.search).toBe('%50!%!_off%');
    expect(sql).toContain('LIMIT 10 OFFSET 10');
    expect(sql).not.toContain('50%_off');
  });

  it('list only sorts by known fields', () => {
    const { sql } = buildList(entity, T, { page: 1, pageSize: 10, sort: 'x; DROP', dir: 'asc' });
    expect(sql).toContain('ORDER BY system_start_ts ASC');
  });

  it('create is a guarded MERGE insert', () => {
    const sql = buildCreate(entity, T);
    expect(sql).toMatch(/^MERGE INTO/);
    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT');
    expect(sql).toContain(':p_code');
  });

  it('update expires and inserts atomically, keys come from the current row', () => {
    const sql = buildUpdate(entity, T);
    expect(sql).toContain('WHEN MATCHED THEN UPDATE SET is_current = false');
    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT');
    expect(sql).toContain('cur.`code` AS `code`');
    expect(sql).not.toContain(':p_code');
    expect(sql).toContain('cur.row_checksum <>');
  });

  it('delete is logical', () => {
    expect(buildDelete(T)).toMatch(/^UPDATE \S+\s+SET is_current = false/);
  });

  it('checksum marks NULLs so concat_ws cannot collapse them', () => {
    expect(checksumExpr(['a', 'b'])).toContain("coalesce(CAST(a AS STRING), '#NULL#')");
  });

  it('escapes LIKE metacharacters', () => expect(escapeLike('a!b%c_d')).toBe('a!!b!%c!_d'));
});
