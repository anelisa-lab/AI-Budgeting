import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      // The backend runs on :4000 everywhere this project documents it
      // (README, .env PORT default, every `uvicorn ... --port 4000`
      // instruction) — :8000 here left `npm run dev`'s default /api calls
      // unable to reach a real backend no matter how correctly it was started.
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
