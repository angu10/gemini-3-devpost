
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 1. Load env vars from .env files
  const env = loadEnv(mode, process.cwd(), '');
  
  // 2. Determine Port: Prefer System Env (Cloud Run) > .env > Default
  const port = process.env.PORT ? parseInt(process.env.PORT) : (parseInt(env.PORT || '8080'));

  console.log(`🚀 Starting Vite Server on PORT: ${port}`);

  return {
    plugins: [react()],
    // Polyfill process.env for client-side code to prevent crashes
    define: {
      'process.env': {}
    },
    server: {
      host: '0.0.0.0', 
      port: port,
      strictPort: true,
      allowedHosts: true, // Vite 7+ specific setting for Cloud Run hosts
      cors: true,
    },
    preview: {
      host: '0.0.0.0',
      port: port,
      strictPort: true,
      allowedHosts: true,
      cors: true,
    },
  };
});
