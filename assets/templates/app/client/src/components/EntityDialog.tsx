import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, ApiError } from '../api';
import { formSchema } from '../schema';
import type { EntityDef, FieldDef, MutationResponse, Row } from '../types';
import { Modal } from './Modal';
import { useToast } from './Toast';

type Mode = 'create' | 'edit' | 'view';
type Option = { value: string; label: string };

const inputClass = 'w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100';

function defaults(e: EntityDef, row?: Row): Record<string, unknown> {
  return Object.fromEntries(
    e.fields.map((f) => [f.name, row?.[f.name] ?? (f.type === 'boolean' ? false : f.type === 'integer' || f.type === 'number' ? null : '')]),
  );
}

export function EntityDialog({ entity, mode, row, onClose }: { entity: EntityDef; mode: Mode; row?: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [serverError, setServerError] = useState<string>();
  const readOnly = mode === 'view';

  // Gate rendering until option lists are loaded — a select without its options shows a blank value.
  const optionFields = entity.fields.filter((f) => f.options);
  const optionQueries = useQueries({
    queries: optionFields.map((f) => ({
      queryKey: ['options', entity.name, f.name],
      queryFn: () => api<{ options: Option[] }>(`/entities/${entity.name}/options/${f.name}`),
      staleTime: 5 * 60_000,
      select: (d: { options: Option[] } | undefined) => (Array.isArray(d?.options) ? d!.options : []), // cache is untrusted
    })),
  });
  const optionsLoading = optionQueries.some((q) => q.isPending);
  const optionsFor = (f: FieldDef) => optionQueries[optionFields.indexOf(f)]?.data ?? [];

  const form = useForm<Record<string, unknown>>({
    defaultValues: defaults(entity, row),
    resolver: readOnly ? undefined : zodResolver(formSchema(entity, mode === 'edit' ? 'edit' : 'create')),
  });

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      mode === 'create'
        ? api<MutationResponse>(`/entities/${entity.name}`, { method: 'POST', body: values })
        : api<MutationResponse>(`/entities/${entity.name}/${encodeURIComponent(row!.row_uid)}`, { method: 'PUT', body: values }),
    onSuccess: (res) => {
      // Background refresh only: never toggle state that unmounts this list's consumer.
      void qc.invalidateQueries({ queryKey: ['entity', entity.name] });
      toast.show(mode === 'create' ? `${entity.label}: created` : res.changed === false ? 'No changes to save' : `${entity.label}: saved`, 'success');
      onClose();
    },
    onError: (err) => setServerError(err instanceof ApiError ? `${err.message} (${err.code})` : 'Save failed'),
  });

  const busy = save.isPending;
  const title = `${mode === 'create' ? 'Add' : mode === 'edit' ? 'Edit' : 'View'} ${entity.label}`;

  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      {optionsLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <fieldset disabled={busy || readOnly} className="space-y-3">
            {entity.fields.map((f) => {
              const locked = mode !== 'create' && entity.key.includes(f.name); // keys are immutable
              const err = form.formState.errors[f.name]?.message as string | undefined;
              const id = `f-${f.name}`;
              const reg = form.register(f.name, {
                setValueAs: f.type === 'integer' || f.type === 'number' ? (v) => (v === '' || v === null ? null : Number(v)) : undefined,
              });
              return (
                <div key={f.name}>
                  <label htmlFor={id} className="mb-1 block text-sm font-medium">
                    {f.label}
                    {f.required && !readOnly && <span className="text-red-600"> *</span>}
                  </label>
                  {f.options ? (
                    <select id={id} className={inputClass} disabled={locked} {...reg}>
                      <option value="">—</option>
                      {optionsFor(f).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === 'boolean' ? (
                    <input id={id} type="checkbox" className="h-4 w-4" disabled={locked} {...reg} />
                  ) : f.type === 'text' ? (
                    <textarea id={id} rows={3} className={inputClass} maxLength={f.maxLength} disabled={locked} {...reg} />
                  ) : (
                    <input
                      id={id}
                      className={inputClass}
                      disabled={locked}
                      type={f.type === 'date' ? 'date' : f.type === 'integer' || f.type === 'number' ? 'number' : 'text'}
                      step={f.type === 'number' ? 'any' : undefined}
                      maxLength={f.maxLength}
                      {...reg}
                    />
                  )}
                  {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
                </div>
              );
            })}
          </fieldset>
          {serverError && <p className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700">{serverError}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={onClose} disabled={busy}>
              {readOnly ? 'Close' : 'Cancel'}
            </button>
            {!readOnly && (
              <button type="submit" className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white" disabled={busy}>
                Save
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
