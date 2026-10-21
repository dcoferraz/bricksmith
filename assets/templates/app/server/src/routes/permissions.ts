import { Router } from 'express';
import { entities } from '../config.js';
import { getStore } from '../db/userClient.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { canUseApp } from '../services/access.js';
import { discoverAll } from '../services/permissions.js';

/** Un-gated: the client needs it to render the access-denied page for non-members. */
export const permissionsRouter = Router();

permissionsRouter.get('/', asyncHandler(async (req, res) => {
  const store = await getStore();
  const body = await store.run(req.userSql, 'permissions.all', async (db) => {
    const appAccess = await canUseApp(db, req.userSql);
    const tables = appAccess ? await discoverAll(db, req.userSql) : {};
    return { appAccess, entities: tables };
  });
  res.json({
    user: { email: req.userSql.email, name: req.userSql.name },
    ...body,
    entityDefs: entities,
  });
}));
