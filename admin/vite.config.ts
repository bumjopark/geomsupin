import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, '..', process.env.DIST_DIR || 'dist', 'admin'), emptyOutDir: true, sourcemap: false, target: 'es2020' },
  server: { port: 8215, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8200', '/files': 'http://127.0.0.1:8200' } },
});
