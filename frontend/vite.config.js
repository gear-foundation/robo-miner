import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
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
