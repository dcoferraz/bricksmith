import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss('./tailwind.config.js')] } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8000', '/healthz': 'http://localhost:8000' },
  },
});
