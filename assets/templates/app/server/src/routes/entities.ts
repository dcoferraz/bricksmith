import { Router, type Request } from 'express';
import { getEntity } from '../config.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  createEntityRow,
  deleteEntityRow,
  entityOptions,
  getEntityRow,
  listEntity,
  updateEntityRow,
} from '../services/entities.js';
import { AppError } from '../types.js';
import { entitySchemas, listQuerySchema } from '../validation/schemas.js';

function entityParam(req: Request) {
  const e = getEntity(req.params.entity);
  if (!e) throw new AppError('NOT_FOUND', 404, `Unknown entity ${req.params.entity}`);
  return e;
}

export const entitiesRouter = Router();

entitiesRouter.get('/:entity', asyncHandler(async (req, res) => {
  const e = entityParam(req);
  res.json(await listEntity(req.userSql, e, listQuerySchema.parse(req.query)));
}));

entitiesRouter.get('/:entity/options/:field', asyncHandler(async (req, res) => {
  res.json(await entityOptions(req.userSql, entityParam(req), req.params.field));
}));

entitiesRouter.get('/:entity/:rowUid', asyncHandler(async (req, res) => {
  res.json(await getEntityRow(req.userSql, entityParam(req), req.params.rowUid));
}));

entitiesRouter.post('/:entity', asyncHandler(async (req, res) => {
  const e = entityParam(req);
  const values = entitySchemas(e).create.parse(req.body ?? {});
  res.status(201).json(await createEntityRow(req.userSql, e, values));
}));

entitiesRouter.put('/:entity/:rowUid', asyncHandler(async (req, res) => {
  const e = entityParam(req);
  const values = entitySchemas(e).update.parse(req.body ?? {});
  res.json(await updateEntityRow(req.userSql, e, req.params.rowUid, values));
}));

entitiesRouter.delete('/:entity/:rowUid', asyncHandler(async (req, res) => {
  res.json(await deleteEntityRow(req.userSql, entityParam(req), req.params.rowUid));
}));
