
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: REPLACE WITH YOUR FIREBASE CONFIG FROM CONSOLE
// If these are missing, the app will gracefully fallback to "No Database" mode.
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

// Initialize Firebase only if config is present
let db: any = null;

try {
  // Simple check to see if config is populated
  if (firebaseConfig.apiKey) {
      const app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      console.log("🔥 Firebase initialized successfully");
  } else {
      console.info("ℹ️ App running in Stateless Mode (Firebase keys not detected). Data will not persist after refresh.");
  }
} catch (e) {
  console.error("Firebase initialization failed:", e);
}

export { db };
