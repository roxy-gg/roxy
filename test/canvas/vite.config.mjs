import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Standalone dev server for the canvas harness (see index.html). */
export default defineConfig({
  root: resolve(import.meta.dirname, '.'),
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@shared': resolve(import.meta.dirname, '../../src/shared'),
      '@renderer': resolve(import.meta.dirname, '../../src/renderer/src')
    }
  },
  optimizeDeps: { include: ['zustand'] },
  plugins: [react(), tailwindcss()],
  server: { port: 3114, strictPort: true }
})
