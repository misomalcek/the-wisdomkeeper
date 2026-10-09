import { defineConfig } from 'vitest/config';

// `base: './'` keeps every asset URL relative, so the build works from any
// GitHub Pages path (user.github.io/the-wisdomkeeper/) without further config.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Rapier ships its WASM inlined as base64 (~4.3 MB raw, ~1.6 MB gzipped) in its own cached chunk.
    chunkSizeWarningLimit: 4500,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : id.includes('node_modules/@dimforge') ? 'rapier' : undefined),
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
