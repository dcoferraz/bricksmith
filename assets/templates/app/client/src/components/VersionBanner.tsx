import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

/** Polls the stamped build version and offers a refresh when a new one is deployed. */
export function VersionBanner() {
  const first = useRef<string>();
  const { data } = useQuery({
    queryKey: ['version'],
    queryFn: async () => {
      const res = await fetch('/version.json', { cache: 'no-store' });
      return res.ok ? ((await res.json()) as { version: string }).version : null;
    },
    refetchInterval: 60_000,
  });
  if (data && !first.current) first.current = data;
  if (!data || data === first.current) return null;
  return (
    <div className="bg-sky-100 px-4 py-2 text-sm text-sky-900">
      A new version is available.{' '}
      <button type="button" className="underline" onClick={() => window.location.reload()}>
        Refresh
      </button>
    </div>
  );
}
