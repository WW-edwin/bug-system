import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY ?? `http://127.0.0.1:${env.PORT ?? 3001}`
  const apiOrigin = new URL(apiTarget).origin
  const apiProxy: ProxyOptions = {
    target: apiTarget,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyRequest) => {
        proxyRequest.setHeader('Origin', apiOrigin)
      })
    },
  }

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 4173,
      proxy: {
        '/api': apiProxy,
        '/uploads': apiProxy,
      },
    },
  }
})
