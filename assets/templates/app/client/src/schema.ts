// Client-side mirror of server/src/validation/schemas.ts. The server re-validates everything.
import { z } from 'zod';
import type { EntityDef, FieldDef } from './types';

function fieldSchema(f: FieldDef): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (f.type === 'integer' || f.type === 'number') {
    let n = z.number({ invalid_type_error: `${f.label} must be a number` });
    if (f.type === 'integer') n = n.int(`${f.label} must be a whole number`);
    if (f.min !== undefined) n = n.min(f.min);
    if (f.max !== undefined) n = n.max(f.max);
    base = n;
  } else if (f.type === 'boolean') {
    base = z.boolean();
  } else if (f.type === 'date') {
    base = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${f.label} must be YYYY-MM-DD`);
  } else {
    let s = z.string().trim();
    if (f.maxLength) s = s.max(f.maxLength, `${f.label}: max ${f.maxLength} characters`);
    base = f.required ? s.min(1, `${f.label} is required`) : s;
  }
  if (f.required) return z.preprocess((v) => (v === '' || v === null ? undefined : v), base);
  return z.preprocess((v) => (v === '' ? null : v), base.nullable().optional());
}

export function formSchema(e: EntityDef, mode: 'create' | 'edit') {
  const fields = mode === 'edit' ? e.fields.filter((f) => !e.key.includes(f.name)) : e.fields;
  return z.object(Object.fromEntries(fields.map((f) => [f.name, fieldSchema(f)])));
}
