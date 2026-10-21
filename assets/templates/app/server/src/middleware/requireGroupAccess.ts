import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getStore } from '../db/userClient.js';
import { canUseApp } from '../services/access.js';
import { AppError } from '../types.js';

/** Coarse "may use the app" gate. Mounted after OBO and after the un-gated permissions/warehouse routes. */
export async function requireGroupAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!config.groupGateEnabled) return next();
  try {
    const store = await getStore();
    const allowed = await store.run(req.userSql, 'access.gate', (db) => canUseApp(db, req.userSql));
    if (allowed) return next();
    next(new AppError('NO_ACCESS', 403, 'You are not a member of a group that may use this app.'));
  } catch (err) {
    next(err);
  }
}
