
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// CRITICAL FIX: Aggressive Service Worker Cleanup
// We use sessionStorage to ensure we only force-reload ONCE per session to clean up workers.
// This prevents infinite reload loops in environments like Project IDX.
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

      // Check if we already reloaded for cleanup in this session
      const hasReloaded = sessionStorage.getItem('sw_cleaned_v2');

      if (!hasReloaded && (unregisterCount > 0 || navigator.serviceWorker.controller)) {
        console.warn('🔄 Service Worker removed. Forcing reload to apply changes...');
        sessionStorage.setItem('sw_cleaned_v2', 'true');
        window.location.reload();
        return true; // Indicates a reload is happening
      }
      
      if (hasReloaded) {
          console.log("✅ Service Worker cleanup check passed (already reloaded).");
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
