# trading-app-v2

暗号資産トレード戦略分析アプリ。アイデアベースから新規構築するプロジェクトです。
基本ルール・技術構成は [btc-strategy](https://github.com/hasebe201114-cyber/btc-strategy)（本番運用中の既存アプリ）を踏襲していますが、
データ・コードは完全に独立しています。

## 技術構成

- React 19 + TypeScript + Vite
- Tailwind CSS（btc-strategyと同じデザインシステムを継承）
- Firebase（Auth / Firestore / Hosting）
- TanStack Query, React Router, Recharts

## セットアップ

```bash
npm install
npm run dev
```

## TODO（初期セットアップ）

- [ ] Firebase Console で本プロジェクト専用の新規Firebaseプロジェクトを作成
- [ ] `src/lib/firebase.ts` の `firebaseConfig` を新規プロジェクトの値に置き換え
- [ ] `.firebaserc` を作成し、`firebase login` / `firebase use` で紐付け
- [ ] `.env.local` に必要な環境変数を設定（APIキー等。Gitにはコミットしない）

## 開発ルール

[CLAUDE.md](./CLAUDE.md) を参照してください。

## ドキュメント

[docs/000-目次.md](./docs/000-目次.md) を参照してください。
