import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Firebase Web SDK config:
// 1) 本番想定: GitHub Secrets (VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID /
//    VITE_FIREBASE_AUTH_DOMAIN) を設定し、.env.local はローカル開発専用。
//    .env.example を経由して Vite ビルド時に import.meta.env.* に注入される。
// 2) フォールバック: GitHub Secrets 未登録で env が空の場合 (Actions build 失敗回避)、
//    04a21ff 以前 (refactor 前) の値で起動。Firebase Console の HTTP referrer 制限が
//    本番防御線のため apiKey 漏えい時のリスクは限定的。Secrets 登録後は不要。
// btc-strategy の Firebase プロジェクトとは共有しない（データ混在防止のため）。
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDcqQXVFfIIzlUGYdq4Ktu143xCH7XIMTg",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "trading-app-v2-94de8",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "trading-app-v2-94de8.firebaseapp.com",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
