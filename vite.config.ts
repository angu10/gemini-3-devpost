
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, process.cwd(), '');
  
  // Cloud Run sets the PORT environment variable (usually 8080)
  const port = parseInt(env.PORT || '8080');

  return {
    plugins: [react()],
    server: {
      // Required for Cloud Run: Bind to 0.0.0.0 to accept external connections
      host: '0.0.0.0',
      port: port,
      // Ensure the server fails if the port is busy, rather than switching ports randomly
      strictPort: true, 
    },
    preview: {
      // Configuration for 'vite preview' command
      host: '0.0.0.0',
      port: port,
      strictPort: true,
      allowedHosts: true
    },
  };
});
