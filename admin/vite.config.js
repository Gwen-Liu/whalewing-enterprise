import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建到服务端的 admin-dist，由服务端在 /admin/ 下直接提供。
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: '../server/admin-dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://localhost:8730', '/join': 'http://localhost:8730' } },
});
