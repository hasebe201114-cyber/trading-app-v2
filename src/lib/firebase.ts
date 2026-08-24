import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Firebase Web SDK config は .env.local から VITE_ プレフィックス付きで読み込む。
// Firebase Web の apiKey はブラウザ公開前提だが、ハードコードを避け .env.example を経由する。
// 1) Firebase Console で本プロジェクト用の新規 Firebase プロジェクトを作成し、
// 2) .env.example を参考に .env.local に VITE_FIREBASE_* を設定する。
// btc-strategy の Firebase プロジェクトとは共有しない（データ混在防止のため）。
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
