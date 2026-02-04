
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 1. Load env vars from .env files
  // Fix: Cast process to any to handle type mismatch for cwd()
  const env = loadEnv(mode, (process as any).cwd(), '');
  
  // 2. Determine Port: Prefer System Env (Cloud Run) > .env > Default
  const port = process.env.PORT ? parseInt(process.env.PORT) : (parseInt(env.PORT || '8080'));

  // 3. Resolve API Key from all possible sources
  // Cloud Run/System Env (API_KEY) > .env (VITE_GEMINI_API_KEY)
  const apiKey = process.env.API_KEY || env.API_KEY || env.VITE_GEMINI_API_KEY || env.REACT_APP_GEMINI_API_KEY;

  console.log(`🚀 Starting Vite Server on PORT: ${port}`);

  return {
    plugins: [react()],
    // Polyfill process.env for client-side code to prevent crashes
    define: {
      'process.env.API_KEY': JSON.stringify(apiKey),
      'process.env': {}
    },
    server: {
      host: '0.0.0.0', 
      port: port,
      strictPort: true,
      cors: true,
      headers: {
        "Access-Control-Expose-Headers": "x-google-upload-url"
      },
      hmr: {
        clientPort: 443 // Force HMR to use HTTPS standard port for Cloud/IDX proxies
      }
    },
    preview: {
      host: '0.0.0.0',
      port: port,
      strictPort: true,
      cors: true,
      headers: {
        "Access-Control-Expose-Headers": "x-google-upload-url"
      }
    },
  };
});
