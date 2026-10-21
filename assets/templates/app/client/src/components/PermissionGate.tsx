import type { ReactNode } from 'react';
import type { Capability, TablePermissions } from '../types';

/** Hide, don't disable: renders nothing when the capability is missing. */
export function PermissionGate({ permissions, cap, children }: { permissions?: TablePermissions; cap: Capability; children: ReactNode }) {
  return permissions?.[cap] ? <>{children}</> : null;
}
