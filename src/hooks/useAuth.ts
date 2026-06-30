/**
 * Google認証フック
 *
 * このアプリは個人利用専用のため、許可されたメールアドレスのみ
 * ログインを許可する（Firestore rules 側でも同じ制約をかける）。
 */

import { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut, User } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';

export const ALLOWED_EMAILS = ['hasebe201114@gmail.com'];

export function useAuth() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = 判定中
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, u => setUser(u));
  }, []);

  const isAllowed = !!user?.email && ALLOWED_EMAILS.includes(user.email);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (!result.user.email || !ALLOWED_EMAILS.includes(result.user.email)) {
        await firebaseSignOut(auth);
        setError('このアカウントにはアクセス権限がありません');
      }
    } catch (e) {
      setError(`ログインに失敗しました: ${e}`);
    }
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
  }, []);

  return { user, isAllowed, error, signIn, signOut };
}
