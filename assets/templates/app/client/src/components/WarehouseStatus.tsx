import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import type { WarehouseState } from '../types';

const DOT: Record<WarehouseState, string> = {
  RUNNING: 'bg-emerald-500',
  STARTING: 'bg-amber-400',
  STOPPING: 'bg-amber-400',
  UNKNOWN: 'bg-amber-400',
  STOPPED: 'bg-red-500',
  DELETING: 'bg-red-500',
  DELETED: 'bg-red-500',
};

export function useWarehouseStatus() {
  return useQuery({
    queryKey: ['warehouse'],
    queryFn: () => api<{ state: WarehouseState }>('/warehouse/status'),
    refetchInterval: (q) => (q.state.data?.state === 'RUNNING' ? 30_000 : 5_000),
    refetchOnWindowFocus: true, // re-check on tab visibility
  });
}

export function WarehouseDot() {
  const state = useWarehouseStatus().data?.state ?? 'UNKNOWN';
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500" title={`SQL warehouse: ${state}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${DOT[state]}`} />
      {state.toLowerCase()}
    </span>
  );
}

/** Non-blocking: the app still works, responses are just slower while the warehouse starts. */
export function WarehouseBanner() {
  const state = useWarehouseStatus().data?.state;
  const [dismissed, setDismissed] = useState(false);
  if (!state || state === 'RUNNING' || state === 'UNKNOWN' || dismissed) return null;
  return (
    <div className="flex items-center justify-between bg-amber-100 px-4 py-2 text-sm text-amber-900">
      <span>The SQL warehouse is {state.toLowerCase()}. Responses may be delayed while it starts.</span>
      <button type="button" className="ml-4 underline" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
