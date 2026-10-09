import { defineConfig } from 'vitest/config';

// `base: './'` keeps every asset URL relative, so the build works from any
// GitHub Pages path (user.github.io/the-wisdomkeeper/) without further config.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: { manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined) },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
