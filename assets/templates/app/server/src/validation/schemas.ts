import { z } from 'zod';
import type { EntityDef, FieldDef, ListQuery } from '../types.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fieldSchema(f: FieldDef): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (f.type) {
    case 'integer':
    case 'number': {
      let n = z.number({ invalid_type_error: `${f.label} must be a number` });
      if (f.type === 'integer') n = n.int(`${f.label} must be a whole number`);
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      base = n;
      break;
    }
    case 'boolean':
      base = z.boolean();
      break;
    case 'date':
      base = z.string().regex(DATE, `${f.label} must be YYYY-MM-DD`);
      break;
    default: {
      let s = z.string().trim();
      if (f.maxLength) s = s.max(f.maxLength);
      if (f.required) s = s.min(1, `${f.label} is required`);
      base = f.options && 'values' in f.options ? s.refine((v) => (f.options as { values: string[] }).values.includes(v), `${f.label} is not an allowed value`) : s;
    }
  }
  // Empty string from a form means "no value".
  const emptyToNull = z.preprocess((v) => (v === '' ? null : v), base.nullable().optional());
  return f.required ? z.preprocess((v) => (v === '' ? undefined : v), base) : emptyToNull;
}

const cache = new Map<string, { create: z.ZodTypeAny; update: z.ZodTypeAny }>();

export function entitySchemas(e: EntityDef) {
  let s = cache.get(e.name);
  if (!s) {
    const all = Object.fromEntries(e.fields.map((f) => [f.name, fieldSchema(f)]));
    const nonKey = Object.fromEntries(e.fields.filter((f) => !e.key.includes(f.name)).map((f) => [f.name, fieldSchema(f)]));
    s = { create: z.object(all).strip(), update: z.object(nonKey).strip() }; // keys are immutable
    cache.set(e.name, s);
  }
  return s;
}

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().max(200).optional(),
  sort: z.string().max(64).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
}) satisfies z.ZodType<ListQuery, z.ZodTypeDef, unknown>;
