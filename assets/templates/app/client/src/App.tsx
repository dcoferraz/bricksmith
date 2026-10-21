import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, setPermissionChangedHandler } from './api';
import { AccessDenied } from './components/AccessDenied';
import { EntityPage } from './components/EntityPage';
import { useToast } from './components/Toast';
import { VersionBanner } from './components/VersionBanner';
import { WarehouseBanner, WarehouseDot } from './components/WarehouseStatus';
import type { PermissionsResponse } from './types';

export default function App() {
  const qc = useQueryClient();
  const toast = useToast();
  const [active, setActive] = useState<string>();

  useEffect(() => {
    setPermissionChangedHandler(() => {
      void qc.invalidateQueries({ queryKey: ['permissions'] });
      void qc.invalidateQueries({ queryKey: ['entity'] });
      toast.show('Your access changed. The page has been updated.', 'warning');
    });
  }, [qc, toast]);

  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api<PermissionsResponse>('/permissions') });

  if (perms.isPending) return <p className="p-6 text-sm text-slate-500">Loading…</p>;
  if (perms.error) {
    const err = perms.error;
    if (err instanceof ApiError && err.code === 'NO_ACCESS') return <AccessDenied />;
    return (
      <p className="m-6 rounded bg-red-50 p-3 text-sm text-red-700">
        {err instanceof ApiError ? `${err.message} (${err.code})` : 'Could not reach the server'}
      </p>
    );
  }
  if (!perms.data.appAccess) return <AccessDenied email={perms.data.user.email} />;

  const defs = perms.data.entityDefs;
  const current = defs.find((e) => e.name === active) ?? defs[0];

  return (
    <div className="min-h-screen">
      <VersionBanner />
      <WarehouseBanner />
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">{document.title}</h1>
        <div className="flex items-center gap-4">
          <WarehouseDot />
          <span className="text-sm text-slate-600">{perms.data.user.name}</span>
        </div>
      </header>
      <nav className="flex gap-1 border-b border-slate-200 bg-white px-6">
        {defs.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => setActive(e.name)}
            className={`border-b-2 px-3 py-2 text-sm ${e.name === current?.name ? 'border-slate-800 font-medium' : 'border-transparent text-slate-500'}`}
          >
            {e.label}
          </button>
        ))}
      </nav>
      <main className="p-6">
        {current && <EntityPage key={current.name} entity={current} initialPermissions={perms.data.entities[current.name]} />}
      </main>
    </div>
  );
}
