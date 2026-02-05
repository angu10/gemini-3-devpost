
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 1. Load env vars from .env files
  const env = loadEnv(mode, process.cwd(), '');
  
  // 2. Determine Port
  const port = process.env.PORT ? parseInt(process.env.PORT) : (parseInt(env.PORT || '8080'));

  // 3. Resolve API Key - CRITICAL FIX:
  // Prioritize `VITE_GEMINI_API_KEY` from .env over `process.env.API_KEY`.
  // Cloud environments often inject a generic `API_KEY` which is not valid for Gemini.
  const apiKey = env.VITE_GEMINI_API_KEY || process.env.API_KEY || env.API_KEY || env.REACT_APP_GEMINI_API_KEY || '';

  console.log(`🚀 Starting Vite Server on PORT: ${port}`);
  if (apiKey) {
      console.log(`🔑 API Key loaded (starts with): ${apiKey.substring(0, 8)}...`);
  } else {
      console.error(`❌ NO API KEY FOUND! Check your .env file.`);
  }

  return {
    plugins: [react()],
    // Polyfill process.env for client-side code
    define: {
      'process.env.API_KEY': JSON.stringify(apiKey),
      // Safely polyfill process.env without overwriting keys
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
      proxy: {
        '/api-proxy': {
          target: 'https://generativelanguage.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api-proxy/, ''),
          secure: false
        }
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
      },
      proxy: {
        '/api-proxy': {
          target: 'https://generativelanguage.googleapis.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api-proxy/, ''),
          secure: false
        }
      },
    },
  };
});
