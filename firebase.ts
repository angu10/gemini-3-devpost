
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// ============================================================================
// 1. SETUP INSTRUCTIONS
// ============================================================================
// To enable persistence (saving analysis results):
// 1. Go to https://console.firebase.google.com/
// 2. Select your project > Project Settings (gear icon) > General.
// 3. Scroll down to "Your apps" > "SDK setup and configuration" > "Config".
// 4. Copy the values (apiKey, authDomain, etc.) and PASTE them below OR into .env
// 5. IMPORTANT: Go to "Build" > "Firestore Database" > "Rules" tab.
//    Change the rules to: 
//    allow read, write: if true; 
//    (This is for development/hackathons only).

// Helper to clean keys (remove quotes if user pasted them into .env)
const clean = (val: string | undefined) => val ? val.replace(/["']/g, "").trim() : undefined;

// Helper to get env var from multiple sources (CRA process.env or Vite import.meta.env)
const getEnv = (key: string) => {
    // 1. Check Vite import.meta.env (Preferred for this project structure)
    try {
        // @ts-ignore
        if (import.meta && import.meta.env && import.meta.env[key]) {
             // @ts-ignore
             return clean(import.meta.env[key]);
        }
    } catch(e) {}

    // 2. Check standard process.env
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
        return clean(process.env[key]);
    }
    
    return undefined;
};

// Config looking for VITE_ prefix first (Standard for Vite), then REACT_APP_ (Standard for CRA)
const firebaseConfig = {
  apiKey: getEnv('VITE_FIREBASE_API_KEY') || getEnv('REACT_APP_FIREBASE_API_KEY') || "PASTE_YOUR_API_KEY_HERE",
  authDomain: getEnv('VITE_FIREBASE_AUTH_DOMAIN') || getEnv('REACT_APP_FIREBASE_AUTH_DOMAIN') || "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: getEnv('VITE_FIREBASE_PROJECT_ID') || getEnv('REACT_APP_FIREBASE_PROJECT_ID') || "PASTE_YOUR_PROJECT_ID",
  storageBucket: getEnv('VITE_FIREBASE_STORAGE_BUCKET') || getEnv('REACT_APP_FIREBASE_STORAGE_BUCKET') || "PASTE_YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: getEnv('VITE_FIREBASE_MESSAGING_SENDER_ID') || getEnv('REACT_APP_FIREBASE_MESSAGING_SENDER_ID') || "PASTE_YOUR_SENDER_ID",
  appId: getEnv('VITE_FIREBASE_APP_ID') || getEnv('REACT_APP_FIREBASE_APP_ID') || "PASTE_YOUR_APP_ID"
};

// Initialize Firebase only if config is valid
let db: any = null;

const isConfigured = firebaseConfig.apiKey && 
                     firebaseConfig.apiKey !== "PASTE_YOUR_API_KEY_HERE" &&
                     !firebaseConfig.apiKey.includes("PASTE_");

if (isConfigured) {
  try {
      const app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      console.log("🔥 Firebase initialized successfully. Persistence is ACTIVE.");
  } catch (e) {
      console.error("Firebase initialization failed:", e);
      console.log("Config used:", firebaseConfig); 
  }
} else {
  console.info("ℹ️ Firebase config missing or default. App running in Stateless/Local Mode.");
}

export { db };
