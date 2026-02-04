
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// CRITICAL FIX: Unregister any existing service workers.
// Stale service workers from previous deployments often intercept API calls 
// and strip critical headers like 'x-google-upload-url'.
const safelyCleanupServiceWorkers = async () => {
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        console.log('Unregistering stale Service Worker:', registration);
        try {
          await registration.unregister();
        } catch (e) {
          console.warn('Failed to unregister worker:', e);
        }
      }
    } catch (e) {
      // Ignored: "The document is in an invalid state" or other security context errors
      // This often happens in Project IDX / Cloud Run previews if the iframe isn't ready.
      console.warn('Skipping Service Worker cleanup (Environment Restricted):', e);
    }
  }
};

// Execute safely without blocking render
safelyCleanupServiceWorkers();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
