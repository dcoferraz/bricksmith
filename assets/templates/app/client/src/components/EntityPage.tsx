import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { EntityDef, ListResponse, Row, TablePermissions } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { EntityDialog } from './EntityDialog';
import { PermissionGate } from './PermissionGate';
import { useToast } from './Toast';

const PAGE_SIZE = 25;

function display(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export function EntityPage({ entity, initialPermissions }: { entity: EntityDef; initialPermissions?: TablePermissions }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<string>();
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [dialog, setDialog] = useState<{ mode: 'create' | 'edit' | 'view'; row?: Row }>();
  const [toDelete, setToDelete] = useState<Row>();

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const list = useQuery({
    queryKey: ['entity', entity.name, { page, search, sort, dir }],
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), dir });
      if (search) qs.set('search', search);
      if (sort) qs.set('sort', sort);
      return api<ListResponse>(`/entities/${entity.name}?${qs}`);
    },
    placeholderData: keepPreviousData,
  });

  // Every data response carries fresh permissions; prefer them over the initial snapshot.
  const permissions = list.data?.permissions ?? initialPermissions;

  const remove = useMutation({
    mutationFn: (row: Row) => api(`/entities/${entity.name}/${encodeURIComponent(row.row_uid)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['entity', entity.name] });
      toast.show(`${entity.label}: deleted`, 'success');
      setToDelete(undefined);
    },
    onError: (err) => {
      toast.show(err instanceof ApiError ? err.message : 'Delete failed', 'error');
      setToDelete(undefined);
    },
  });

  const columns = entity.fields.slice(0, 7);
  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  const toggleSort = (name: string) => {
    if (sort === name) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(name);
      setDir('asc');
    }
  };

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <input
          type="search"
          placeholder={`Search ${entity.label.toLowerCase()}…`}
          className="w-full max-w-xs rounded border border-slate-300 px-2 py-1.5 text-sm"
          value={searchInput}
          onChange={(ev) => setSearchInput(ev.target.value)}
        />
        <PermissionGate permissions={permissions} cap="canCreate">
          <button type="button" className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white" onClick={() => setDialog({ mode: 'create' })}>
            Add {entity.label}
          </button>
        </PermissionGate>
      </div>

      {list.error ? (
        <p className="rounded bg-red-50 p-3 text-sm text-red-700">
          {list.error instanceof ApiError ? `${list.error.message} (${list.error.code})` : 'Could not load data'}
        </p>
      ) : permissions && !permissions.canRead ? (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">You do not have read access to {entity.label}.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 text-left">
              <tr>
                {columns.map((f) => (
                  <th key={f.name} className="cursor-pointer px-3 py-2 font-medium" onClick={() => toggleSort(f.name)}>
                    {f.label}
                    {sort === f.name ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              )}
              {list.data?.rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-slate-500">
                    No records.
                  </td>
                </tr>
              )}
              {list.data?.rows.map((row) => (
                <tr key={row.row_uid} className="border-t border-slate-100">
                  {columns.map((f) => (
                    <td key={f.name} className="px-3 py-2">
                      {display(row[f.name])}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{row.updated_at}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      className="mr-3 text-slate-700 underline"
                      onClick={() => setDialog({ mode: permissions?.canUpdate ? 'edit' : 'view', row })}
                    >
                      {permissions?.canUpdate ? 'Edit' : 'View'}
                    </button>
                    <PermissionGate permissions={permissions} cap="canDelete">
                      <button type="button" className="text-red-600 underline" onClick={() => setToDelete(row)}>
                        Delete
                      </button>
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2 text-sm">
        <span className="text-slate-500">
          {list.data?.total ?? 0} records · page {page} of {totalPages}
        </span>
        <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Prev
        </button>
        <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>

      {dialog && <EntityDialog entity={entity} mode={dialog.mode} row={dialog.row} onClose={() => setDialog(undefined)} />}
      {toDelete && (
        <ConfirmDialog
          title={`Delete ${entity.label}`}
          message="This record will be expired. Its history is kept for audit."
          busy={remove.isPending}
          onConfirm={() => remove.mutate(toDelete)}
          onCancel={() => setToDelete(undefined)}
        />
      )}
    </section>
  );
}
