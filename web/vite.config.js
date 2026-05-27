import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://camera.tranhtuongtravinh.com',
        changeOrigin: true,
      },
      '/ws': {
        target: 'wss://camera.tranhtuongtravinh.com',
        ws: true,
      },
      '/media': {
        target: 'https://camera.tranhtuongtravinh.com',
        changeOrigin: true,
      },
    },
  },
});
