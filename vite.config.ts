import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const isLocalDev = !!process.env.DEV_PROXY_VPS;
const VPS_ORIGIN = process.env.DEV_PROXY_VPS || 'https://localhost:5174';

// Plugin to copy @novnc/novnc lib files to dist/browser/lib/ during build
function copyNovncPlugin() {
  return {
    name: 'copy-novnc',
    closeBundle() {
      const src = path.resolve(__dirname, 'node_modules/@novnc/novnc/lib');
      const dest = path.resolve(__dirname, 'dist/browser/lib');

      function copyDir(srcDir: string, destDir: string) {
        fs.mkdirSync(destDir, { recursive: true });
        for (const entry of fs.readdirSync(srcDir)) {
          const srcPath = path.join(srcDir, entry);
          const destPath = path.join(destDir, entry);
          const stat = fs.statSync(srcPath);
          if (stat.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }

      copyDir(src, dest);
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), copyNovncPlugin()],
  server: {
    host: '0.0.0.0',
    port: isLocalDev ? 5174 : 3001,
    allowedHosts: true,
    ...(!isLocalDev && fs.existsSync(path.resolve(__dirname, 'localhost+2-key.pem')) ? {
      https: {
        key: fs.readFileSync(path.resolve(__dirname, 'localhost+2-key.pem')),
        cert: fs.readFileSync(path.resolve(__dirname, 'localhost+2.pem'))
      }
    } : {}),
    proxy: isLocalDev ? {
      // Dev on control server: proxy to VPS
      '/gateway': {
        target: VPS_ORIGIN.replace('https', 'wss'),
        ws: true,
        changeOrigin: true,
        secure: true
      },
      '/api': {
        target: VPS_ORIGIN,
        changeOrigin: true,
        secure: true
      }
    } : {
      // Dev on VPS itself: proxy to local services
      '/gateway': {
        target: 'ws://127.0.0.1:18789',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gateway/, ''),
        secure: false,
        headers: {
          'X-Forwarded-For': '127.0.0.1',
          'X-Forwarded-Proto': 'http',
        }
      },
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        secure: false
      },
      '/browser': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        ws: true,
        secure: false
      }
    }
  }
})

