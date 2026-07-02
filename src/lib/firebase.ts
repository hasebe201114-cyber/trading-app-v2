import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// TODO: Firebase Console で本プロジェクト専用の新規プロジェクトを作成し、
// その設定値（apiKey / projectId / authDomain）に置き換えること。
// btc-strategy の Firebase プロジェクトとは共有しない（データ混在防止のため）。
const firebaseConfig = {
  apiKey: "AIzaSyDcqQXVFfIIzlUGYdq4Ktu143xCH7XIMTg",
  projectId: "trading-app-v2-94de8",
  authDomain: "trading-app-v2-94de8.firebaseapp.com",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
