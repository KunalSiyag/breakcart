import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// Where the dev server forwards API traffic. Override when the stack runs elsewhere,
// e.g. BREAKCART_GATEWAY_URL=http://192.168.1.20:3000 npm run dev
const GATEWAY_URL = process.env.BREAKCART_GATEWAY_URL ?? 'http://localhost:3000';
const CONTROL_URL = process.env.BREAKCART_CONTROL_URL ?? 'http://localhost:3010';

const proxy: Record<string, ProxyOptions> = {
  '/api': { target: GATEWAY_URL, xfwd: true },
  '/control': {
    target: CONTROL_URL,
    xfwd: true,
    // The war room keeps an EventSource open on /control/events. http-proxy streams
    // responses as they arrive; we only make sure no intermediary buffers or transforms them.
    configure(proxyServer) {
      proxyServer.on('proxyRes', (proxyRes) => {
        const type = String(proxyRes.headers['content-type'] ?? '');
        if (type.includes('text/event-stream')) {
          proxyRes.headers['cache-control'] = 'no-cache, no-transform';
          proxyRes.headers['x-accel-buffering'] = 'no';
        }
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 5180,
    strictPort: true,
    proxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
