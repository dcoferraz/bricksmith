// Mirrored from server/src/types.ts — change both in the same PR.

export type FieldType = 'string' | 'text' | 'integer' | 'number' | 'boolean' | 'date';

export interface LookupSource {
  table: string;
  valueColumn: string;
  labelColumn: string;
  currentOnly?: boolean;
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

export type Row = Record<string, unknown> & { row_uid: string; updated_by?: string; updated_at?: string };

export interface PermissionsResponse {
  user: { email: string; name: string };
  appAccess: boolean;
  entities: Record<string, TablePermissions>;
  entityDefs: EntityDef[];
}

export interface ListResponse {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  permissions: TablePermissions;
}

export interface MutationResponse {
  row?: Row;
  changed?: boolean;
  permissions: TablePermissions;
}

export type WarehouseState = 'RUNNING' | 'STARTING' | 'STOPPING' | 'STOPPED' | 'DELETING' | 'DELETED' | 'UNKNOWN';
