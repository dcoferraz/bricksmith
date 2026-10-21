import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getWarehouseStatus } from '../services/warehouseStatus.js';

/** Un-gated: tells users the warehouse is waking instead of looking broken. */
export const warehouseRouter = Router();

warehouseRouter.get('/status', asyncHandler(async (req, res) => {
  res.json(await getWarehouseStatus(req.userSql));
}));
