import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { displayNameFromEmail } from '../identifiers.js';

/** Identity comes from the Databricks Apps proxy headers. Fallbacks exist only for local dev and tests. */
export function oboMiddleware(req: Request, res: Response, next: NextFunction): void {
  const allowFallback = config.isLocal || config.useFakeDb; // never true when deployed
  const token = req.header('X-Forwarded-Access-Token') ?? (allowFallback ? config.localToken ?? 'fake-token' : undefined);
  const email =
    req.header('X-Forwarded-Email') ??
    req.header('X-Forwarded-Preferred-Username') ??
    (allowFallback ? config.devUserEmail : undefined);
  if (!token || !email) {
    res.status(401).json({ error: 'MISSING_OBO_TOKEN', message: 'No forwarded user identity. Open the app through Databricks.' });
    return;
  }
  req.userSql = { token, email, name: displayNameFromEmail(email) };
  next();
}
