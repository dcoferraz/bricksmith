// Mirrored in client/src/types.ts — change both in the same PR.

export type FieldType = 'string' | 'text' | 'integer' | 'number' | 'boolean' | 'date';

export interface LookupSource {
  table: string; // bare name (resolved in the app catalog/schema) or catalog.schema.table
  valueColumn: string;
  labelColumn: string;
  currentOnly?: boolean; // filter is_current = true (lookup is itself a bi-temporal entity)
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  options?: { values: string[] } | { lookup: LookupSource };
}

export interface EntityDef {
  name: string;
  label: string;
  table: string;
  key: string[];
  fields: FieldDef[];
}

export interface TablePermissions {
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  checkedAt: string;
}

export type Capability = 'canRead' | 'canCreate' | 'canUpdate' | 'canDelete';

export type ErrorCode =
  | 'MISSING_OBO_TOKEN'
  | 'NO_ACCESS'
  | 'PERMISSION_CHANGED'
  | 'WAREHOUSE_FORBIDDEN'
  | 'WAREHOUSE_UNAVAILABLE'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export interface UserSqlContext {
  token: string; // request-scoped only: never log, return, or persist
  email: string;
  name: string;
}

export type Row = Record<string, unknown>;
export type SqlParams = Record<string, string | number | boolean | null>;

export interface ListQuery {
  page: number;
  pageSize: number;
  search?: string;
  sort?: string;
  dir: 'asc' | 'desc';
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userSql: UserSqlContext;
    }
  }
}
