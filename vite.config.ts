
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 1. Load env vars from .env files
  const env = loadEnv(mode, process.cwd(), '');
  
  // 2. Determine Port: Prefer System Env (Cloud Run) > .env > Default
  // Note: Cloud Run injects PORT into process.env, which loadEnv might not merge by default.
  const port = process.env.PORT ? parseInt(process.env.PORT) : (parseInt(env.PORT || '8080'));

  console.log(`🚀 Starting Vite Server on PORT: ${port}`);

  return {
    plugins: [react()],
    server: {
      host: true, // Listen on 0.0.0.0 (Required for Cloud Run/Docker)
      port: port,
      strictPort: true, // Fail if port is busy
      allowedHosts: true, // Allow cloud-run domain names
      cors: true,
    },
    preview: {
      host: true, // Listen on 0.0.0.0 (Required for Cloud Run/Docker)
      port: port,
      strictPort: true,
      allowedHosts: true, // Allow cloud-run domain names
      cors: true,
    },
  };
});
