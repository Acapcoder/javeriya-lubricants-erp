import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5200,
    // Fail loudly on a port clash. Vite's default is to slide to the next free
    // port, which silently leaves you looking at a different project's app.
    strictPort: true,
    // The API is same-origin in production (one server fronts both); in dev we
    // proxy so cookies keep working without CORS or SameSite relaxation.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3200',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
