const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Identifiers never come from user input; they come from config and are validated here. */
export function assertIdentifier(name: string, what = 'SQL'): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid ${what} identifier: ${JSON.stringify(name)}`);
  return name;
}

/** Back-tick quote a validated identifier. */
export function q(name: string): string {
  return `\`${assertIdentifier(name)}\``;
}

/** Quote a dotted name (catalog.schema.table), validating every part. */
export function qualified(parts: string[]): string {
  return parts.map((p) => q(p)).join('.');
}

/**
 * Accepts a full HTTP path, a bare warehouse id, or a JDBC URL and returns
 * `/sql/1.0/warehouses/<id>`-style paths. A bare id makes every query 404.
 */
export function normalizeHttpPath(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const jdbc = /httpPath=([^;]+)/i.exec(value);
  if (jdbc) return jdbc[1].startsWith('/') ? jdbc[1] : `/${jdbc[1]}`;
  if (value.startsWith('/')) return value;
  if (value.startsWith('sql/')) return `/${value}`;
  if (/^[A-Za-z0-9]+$/.test(value)) return `/sql/1.0/warehouses/${value}`;
  return value;
}

export function warehouseIdFromPath(path: string | undefined): string | undefined {
  return /warehouses\/([^/?;]+)/.exec(path ?? '')?.[1];
}

/** Driver wants a bare hostname; REST calls want https://host. */
export function normalizeHost(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return value || undefined;
}

export function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}
