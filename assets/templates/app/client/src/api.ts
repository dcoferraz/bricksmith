import type { ErrorCode } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let onPermissionChanged: () => void = () => undefined;

/** Central 403 PERMISSION_CHANGED flow: refresh permissions + toast. Components must not swallow it. */
export function setPermissionChangedHandler(handler: () => void): void {
  onPermissionChanged = handler;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: { error?: ErrorCode; message?: string; details?: unknown } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined; // e.g. an SSO page instead of JSON
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? 'INTERNAL', data?.message ?? `Request failed (${res.status})`, data?.details);
    if (err.code === 'PERMISSION_CHANGED') onPermissionChanged();
    throw err;
  }
  return data as T;
}
