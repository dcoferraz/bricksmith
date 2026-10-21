import { describe, expect, it } from 'vitest';
import { assertIdentifier, displayNameFromEmail, normalizeHost, normalizeHttpPath, q } from '../src/identifiers.js';

describe('normalizeHttpPath', () => {
  it('accepts a full path', () => expect(normalizeHttpPath('/sql/1.0/warehouses/abc123')).toBe('/sql/1.0/warehouses/abc123'));
  it('expands a bare warehouse id (otherwise every query 404s)', () =>
    expect(normalizeHttpPath('abc123')).toBe('/sql/1.0/warehouses/abc123'));
  it('extracts httpPath from a JDBC URL', () =>
    expect(normalizeHttpPath('jdbc:databricks://h:443/default;transportMode=http;httpPath=/sql/1.0/warehouses/xyz;AuthMech=3')).toBe(
      '/sql/1.0/warehouses/xyz',
    ));
  it('returns undefined for empty', () => expect(normalizeHttpPath('  ')).toBeUndefined());
});

describe('identifiers', () => {
  it('quotes valid identifiers', () => expect(q('my_table1')).toBe('`my_table1`'));
  it('rejects injection attempts', () => {
    expect(() => assertIdentifier('t; DROP TABLE x')).toThrow();
    expect(() => assertIdentifier('a`b')).toThrow();
    expect(() => assertIdentifier('1abc')).toThrow();
  });
  it('strips scheme from host', () => expect(normalizeHost('https://x.cloud.databricks.com/')).toBe('x.cloud.databricks.com'));
  it('derives a display name from email', () => expect(displayNameFromEmail('jane.doe@example.com')).toBe('Jane Doe'));
});
