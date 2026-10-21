import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { isPermissionDenied, redact } from '../db/databricksClient.js';
import { AppError } from '../types.js';

/** Express 4 does not catch rejected promises. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Structured ErrorCode + message. Never leaks SQL, stack traces, or tokens. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'VALIDATION', message: 'Some fields are invalid.', details: err.flatten().fieldErrors });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }
  if (isPermissionDenied(err)) {
    res.status(403).json({ error: 'PERMISSION_CHANGED', message: 'Your access to this data changed.' });
    return;
  }
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(`[error] ${req.method} ${req.path}: ${redact(msg)}`);
  res.status(500).json({ error: 'INTERNAL', message: 'Unexpected error. Try again or contact support.' });
}
