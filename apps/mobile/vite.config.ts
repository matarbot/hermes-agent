import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Absolute paths to the shared desktop source — mobile only contributes
// a bridge + entry point; the renderer source lives in apps/desktop/src/.
const desktopSrc = path.resolve(__dirname, '../desktop/src')
const desktopPublic = path.resolve(__dirname, '../desktop/public')
const sharedSrc = path.resolve(__dirname, '../shared/src')

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  css: {
    postcss: { plugins: [] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 25000,
    rollupOptions: {
      output: {
        manualChunks: undefined, // no code splitting for mobile — single bundle
      },
    },
  },
  resolve: {
    alias: {
      // Desktop renderer source is the canonical @/ target.
      '@': desktopSrc,
      '@hermes/shared': sharedSrc,
      // Mobile source (bridge, stubs) uses @/ prefix too.
      '@mobile': path.resolve(__dirname, 'src'),
      // Override the translucency side-effect import so the desktop's
      // Electron-specific code (uses hermesDesktop.setTranslucency) is
      // replaced by a no-op for mobile.
      '@/store/translucency': path.resolve(__dirname, 'src/translucency-stub.ts'),
      // Resolve react from the monorepo root so both mobile and desktop
      // share the exact same copies.
      react: path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      'react/jsx-dev-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-dev-runtime.js'),
      'react/jsx-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-runtime.js'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
  },
  publicDir: desktopPublic,
})
