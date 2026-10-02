import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// LAN access: bind IPv4 explicitly so other PCs can reach http://<ipc-ip>:5184
const sharedServer = {
  host: '0.0.0.0',
  port: 5184,
  strictPort: true,
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
