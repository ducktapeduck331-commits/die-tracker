// Paste your Firebase web app config here (Firebase console → Project settings → Your apps → Web app).
// These values ship in every Firebase web app; they identify the project. Access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDIAklRASgH_nsmqFmZy5D9ChFn3MzCx0U",
  authDomain: "br-die-tracker.firebaseapp.com",
  projectId: "br-die-tracker",
  storageBucket: "br-die-tracker.firebasestorage.app",
  messagingSenderId: "383828065164",
  appId: "1:383828065164:web:08e5e635aa5502cd4db4a9"
};

// Until the config is pasted in, the app runs in local-only mode (stats stay on this device).
export const configured = firebaseConfig.apiKey !== "PASTE_HERE";
