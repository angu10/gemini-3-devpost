
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// ============================================================================
// 1. SETUP INSTRUCTIONS
// ============================================================================
// To enable persistence (saving analysis results):
// 1. Go to https://console.firebase.google.com/
// 2. Select your project > Project Settings (gear icon) > General.
// 3. Scroll down to "Your apps" > "SDK setup and configuration" > "Config".
// 4. Copy the values (apiKey, authDomain, etc.) and PASTE them below.
// 5. IMPORTANT: Go to "Build" > "Firestore Database" > "Rules" tab.
//    Change the rules to: 
//    allow read, write: if true; 
//    (This is for development/hackathons only).

const firebaseConfig = {
  // REPLACE THE STRINGS BELOW WITH YOUR FIREBASE KEYS
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY || "PASTE_YOUR_API_KEY_HERE",
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || "PASTE_YOUR_PROJECT_ID",
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || "PASTE_YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || "PASTE_YOUR_SENDER_ID",
  appId: process.env.REACT_APP_FIREBASE_APP_ID || "PASTE_YOUR_APP_ID"
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
  }
} else {
  console.info("ℹ️ Firebase config missing or default. App running in Stateless/Local Mode.");
}

export { db };
