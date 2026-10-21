// Opt-in (WARM_SESSION_CACHE=true): reuse a live session across one user's requests to skip the handshake.
// Key = sha256(token): never shared across identities, token never stored in plaintext.
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type { UserSqlContext } from '../types.js';
import type { DBSQLSession, Lease } from './databricksClient.js';

type Opened<C> = { client: C; session: DBSQLSession };
type Open<C> = (ctx: UserSqlContext, label: string) => Promise<Opened<C>>;
type Close<C> = (client: C, session: DBSQLSession) => Promise<void>;

interface Entry {
  client: unknown;
  session: DBSQLSession;
  busy: boolean;
  lastUsed: number;
  close: () => Promise<void>;
}

const MAX_ENTRIES = 50;
const entries = new Map<string, Entry>(); // insertion order doubles as LRU order

const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

function discard(key: string, entry: Entry): void {
  if (entries.get(key) === entry) entries.delete(key);
  void entry.close();
}

function sweep(): void {
  const now = Date.now();
  for (const [key, e] of entries) if (!e.busy && now - e.lastUsed > config.warmSessionTtlMs) discard(key, e);
  while (entries.size > MAX_ENTRIES) {
    const oldestIdle = [...entries].find(([, e]) => !e.busy);
    if (!oldestIdle) break;
    discard(oldestIdle[0], oldestIdle[1]);
  }
}

if (config.warmSessionCache) setInterval(sweep, Math.max(5_000, config.warmSessionTtlMs)).unref();

export async function acquire<C>(ctx: UserSqlContext, label: string, open: Open<C>, close: Close<C>): Promise<Lease> {
  sweep();
  const key = tokenKey(ctx.token);
  const existing = entries.get(key);

  if (existing?.busy) {
    // One session cannot run two statements: same-user concurrency gets an ephemeral extra session.
    const { client, session } = await open(ctx, label);
    return { session, release: () => close(client, session) };
  }

  let entry = existing;
  if (!entry) {
    const { client, session } = await open(ctx, label);
    entry = { client, session, busy: false, lastUsed: Date.now(), close: () => close(client, session) };
  }
  entries.delete(key);
  entries.set(key, entry); // most recently used last
  entry.busy = true;
  const leased = entry;
  return {
    session: leased.session,
    release: async (ok: boolean) => {
      leased.busy = false;
      leased.lastUsed = Date.now();
      if (!ok) discard(key, leased); // discard on any error
    },
  };
}
