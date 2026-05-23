/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
    // Split heavy / rarely-loaded vendor code into named chunks so they
    // can be cached independently and not block first paint. Without
    // this everything not already React.lazy'd ended up in a single
    // ~1.4MB index bundle. Each group below is roughly one feature
    // surface that only some routes touch.
    // Vite 8 ships rolldown which only accepts the function form of
    // manualChunks (the object form errors out with "Expected Function
    // but received Object"). Map module IDs to chunk names by pattern.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router-dom|react-router|scheduler)[\\/]/.test(id)) {
            return 'vendor-react'
          }
          if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) {
            return 'vendor-charts'
          }
          if (/[\\/]node_modules[\\/]@xterm[\\/]/.test(id)) {
            return 'vendor-term'
          }
          if (/[\\/]node_modules[\\/]asciinema-player[\\/]/.test(id)) {
            return 'vendor-asciinema'
          }
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) {
            return 'vendor-radix'
          }
          if (/[\\/]node_modules[\\/](i18next|react-i18next)[\\/]/.test(id)) {
            return 'vendor-i18n'
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) {
            return 'vendor-query'
          }
          // lucide-react is grouped despite being ~600 kB raw — when
          // tree-shaken into index.js it inflates the main bundle and
          // re-downloads on every release. As its own chunk the
          // content-hashed filename is stable until lucide bumps,
          // so it caches forever and downloads in parallel with index.
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) {
            return 'vendor-icons'
          }
          if (/[\\/]node_modules[\\/](react-hook-form|@hookform|zod)[\\/]/.test(id)) {
            return 'vendor-forms'
          }
          return undefined
        },
      },
    },
    // Pre-existing 500 kB warning was driven by the un-split bundle.
    // After splitting the largest chunk is vendor-charts ~330 kB —
    // raise the threshold so we don't get noise we can't act on.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/agent': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    css: false,
  },
})
