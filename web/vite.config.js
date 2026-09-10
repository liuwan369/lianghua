import { defineConfig } from 'vite';
export default defineConfig({
  base: '/console/',
  build: { outDir: '../docs/console', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8765' } },
  test: { environment: 'jsdom' },
});
