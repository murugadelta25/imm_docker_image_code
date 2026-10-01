import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// LAN access: allow din.eappms, IP addresses, and any host on the factory network.
const sharedServer = {
  host: true,
  port: 5184,
  allowedHosts: true,
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8040',
      changeOrigin: true,
    },
    '/static': {
      target: 'http://127.0.0.1:8040',
      changeOrigin: true,
    },
    '/ws': {
      target: 'ws://127.0.0.1:8040',
      ws: true,
      changeOrigin: true,
    },
  },
}

export default defineConfig({
  plugins: [react()],
  server: sharedServer,
  preview: sharedServer,
})
