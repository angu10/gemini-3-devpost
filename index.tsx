
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// CRITICAL FIX: Aggressive Service Worker Cleanup
// If a Service Worker is controlling the page, it causes the "missing x-google-upload-url" error
// by stripping headers from the Google API response.
const nukeServiceWorkers = async () => {
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      let unregisterCount = 0;
      
      for (const registration of registrations) {
        console.warn('⚠️ Found stale Service Worker:', registration);
        await registration.unregister();
        unregisterCount++;
      }

      // If we removed a worker, or if one is currently controlling the page, we MUST reload.
      if (unregisterCount > 0 || navigator.serviceWorker.controller) {
        console.warn('🔄 Service Worker removed. Forcing reload to apply changes...');
        window.location.reload();
        return true; // Indicates a reload is happening
      }
    } catch (e) {
      console.warn('Service Worker cleanup warning:', e);
    }
  }
  return false;
};

const init = async () => {
  const isReloading = await nukeServiceWorkers();
  
  // Do not mount the app if we are about to reload, avoids flickering
  if (isReloading) return;

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
};

init();
