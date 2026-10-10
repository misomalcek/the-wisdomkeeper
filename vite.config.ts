import { defineConfig } from 'vitest/config';

// `base: './'` keeps every asset URL relative, so the build works from any
// GitHub Pages path (user.github.io/the-wisdomkeeper/) without further config.
// `three` resolves to the WebGPU build (WebGPURenderer + node materials + TSL, with an automatic WebGL2
// backend), so the whole app and the addons share one copy of the library.
export default defineConfig({
  base: './',
  resolve: {
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
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
