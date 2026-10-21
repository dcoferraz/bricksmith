import { config, describeConfig } from './config.js';
import { createApp } from './app.js';

console.info('[boot] effective config', JSON.stringify(describeConfig()));

createApp().listen(config.port, '0.0.0.0', () => {
  console.info(`[boot] listening on 0.0.0.0:${config.port}`);
});
