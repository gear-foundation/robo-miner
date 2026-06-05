import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  preview: {
    allowedHosts: ['robo-miner-production.up.railway.app'],
  },
  build: {
    target: 'es2020',
  },
});
