import { defineConfig } from 'vite';

function cspSafePhaserGlobalFallback() {
  const evalGlobalFallback = /new Function\s*\(\s*["']return this["']\s*\)\s*\(\s*\)/g;
  return {
    name: 'csp-safe-phaser-global-fallback',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        chunk.code = chunk.code.replace(
          evalGlobalFallback,
          '(typeof window=="object"?window:{})',
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [cspSafePhaserGlobalFallback()],
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
