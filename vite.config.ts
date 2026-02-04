
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 1. Load env vars from .env files
  // Fix: Cast process to any to handle type mismatch for cwd()
  const env = loadEnv(mode, (process as any).cwd(), '');
  
  // 2. Determine Port: Prefer System Env (Cloud Run) > .env > Default
  const port = process.env.PORT ? parseInt(process.env.PORT) : (parseInt(env.PORT || '8080'));

  console.log(`🚀 Starting Vite Server on PORT: ${port}`);

  return {
    plugins: [react()],
    // Polyfill process.env for client-side code to prevent crashes
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
      'process.env': {}
    },
    server: {
      host: '0.0.0.0', 
      port: port,
      strictPort: true,
      cors: true,
      hmr: {
        clientPort: 443 // Force HMR to use HTTPS standard port for Cloud/IDX proxies
      }
    },
    preview: {
      host: '0.0.0.0',
      port: port,
      strictPort: true,
      cors: true,
    },
  };
});
