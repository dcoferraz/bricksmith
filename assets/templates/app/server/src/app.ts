import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { errorHandler } from './middleware/errorHandler.js';
import { oboMiddleware } from './middleware/obo.js';
import { requireGroupAccess } from './middleware/requireGroupAccess.js';
import { entitiesRouter } from './routes/entities.js';
import { permissionsRouter } from './routes/permissions.js';
import { warehouseRouter } from './routes/warehouse.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(oboMiddleware);
  api.use('/permissions', permissionsRouter); // un-gated
  api.use('/warehouse', warehouseRouter); // un-gated
  api.use(requireGroupAccess);
  api.use('/entities', entitiesRouter);
  api.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown API route' });
  });
  app.use('/api', api);

  // Same container serves the React build. The browser only ever talks to same-origin /api.
  const clientDist = path.resolve(process.cwd(), 'client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
