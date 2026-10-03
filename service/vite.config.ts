import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Client: src/client → dist/client. In dev, /api and /reports proxy to the server.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/reports': 'http://localhost:8080' },
  },
});
