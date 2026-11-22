import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const gatewayTarget = process.env.GATEWAY_PROXY_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': gatewayTarget,
      '/health': gatewayTarget,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
