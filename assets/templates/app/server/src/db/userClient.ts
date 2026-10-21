// Provider facade. Services only see `Db`; they never build connections or hand-roll writes.
import { config } from '../config.js';
import type { EntityDef, ListQuery, Row, TablePermissions, UserSqlContext } from '../types.js';

export type UcPermissions = Omit<TablePermissions, 'checkedAt'>;
export interface Option {
  value: string;
  label: string;
}

export interface Db {
  list(e: EntityDef, query: ListQuery): Promise<{ rows: Row[]; total: number }>;
  get(e: EntityDef, rowUid: string): Promise<Row | null>;
  /** Returns null when a current row with the same key already exists. */
  create(e: EntityDef, values: Record<string, unknown>): Promise<Row | null>;
  /** `changed: false` when the checksum is equal (no new version written). Null when not found. */
  update(e: EntityDef, rowUid: string, values: Record<string, unknown>): Promise<{ row: Row; changed: boolean } | null>;
  /** Logical delete. False when not found. */
  remove(e: EntityDef, rowUid: string): Promise<boolean>;
  options(e: EntityDef, fieldName: string): Promise<Option[]>;
  /** What Unity Catalog grants this user on the entity table. */
  tablePermissions(e: EntityDef): Promise<UcPermissions>;
  groupMembership(groups: string[]): Promise<Record<string, boolean>>;
}

export interface Store {
  /** One OBO session per call: everything inside `fn` runs as the user on the same session. */
  run<T>(ctx: UserSqlContext, label: string, fn: (db: Db) => Promise<T>): Promise<T>;
}

let store: Promise<Store> | undefined;

export function getStore(): Promise<Store> {
  store ??= config.useFakeDb
    ? import('./fakeDb.js').then((m) => m.fakeStore)
    : import('./sqlStore.js').then((m) => m.sqlStore);
  return store;
}
