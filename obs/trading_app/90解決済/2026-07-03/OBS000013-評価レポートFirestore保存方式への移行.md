# OBS000013 - 評価レポートのFirestore保存方式への移行

## 変更履歴
- 2026-07-03: 起票・実装。Firebase接続（Firestore DB作成・ルールデプロイ）と、評価レポートのFirestore読み書きを実装
- 2026-07-03: ユーザが実ブラウザで保存ボタンの動作を確認。解決済へ移動

## 関連ドキュメント
- 派生元: [OBS000012-評価ダッシュボード実データ接続.md](../../80実装中/2026-07-01/OBS000012-評価ダッシュボード実データ接続.md)（「Firebase接続後はFirestore保存方式に置き換える想定」の実行）
- [PJ000001-...](../../00プロジェクト方針/PJ000001-AI判断×統計パターン認識ハイブリッド自動売買エンジン.md) 4節（評価・チューニング層）
- [D001-開発計画.md](../../../../docs/D-開発者向けシステム仕様編/D001-開発計画.md) Phase 0（Firebase接続の完了）

## 背景
OBS000012時点では、評価レポートはビルド同梱のJSONスナップショット（`src/data/evaluationReport.json`）を
直接importして表示しており、レポート更新のたびにコミット・デプロイが必要だった。
Firebaseプロジェクトのセットアップ（ユーザ作業）が完了したため、Firestore保存方式へ移行した。

## 環境セットアップ（本件で実施）
- Firebaseプロジェクト `trading-app-v2-94de8` をユーザが作成、`src/lib/firebase.ts` に設定値を反映（コミット済み）
- Firebase Console で Google認証を有効化（ユーザ作業）
- Cloud Firestore API を有効化し、Firestoreデータベースを **asia-northeast1（東京）** に作成（CLI経由）
- `firebase.json` の location を us-central1 → asia-northeast1 に修正
- `.firebaserc` を新規作成（default = trading-app-v2-94de8）
- `firestore.rules` に `evaluationReports` コレクションのルールを追加（isOwnerのみ読み書き可）し、デプロイ済み

## 実装内容
- `src/lib/evaluationReports.ts`（新規）:
  - `EvaluationReport` / `EvaluationFold` 型定義（JSONスナップショットと同形）
  - `saveEvaluationReport()`: `evaluationReports` コレクションへ保存。docIdはgeneratedAtベースの決定的な値とし、同一レポートの重複保存を防止
  - `fetchLatestEvaluationReport()`: generatedAt降順で最新1件を取得
- `EvaluationScreen.tsx`:
  - React Query でFirestoreから最新レポートを取得して表示。未保存・取得失敗時はビルド同梱スナップショットにフォールバック
  - 「レポートデータソース」セクションを追加（表示中データの出所を明示）
  - 「スナップショットをFirestoreへ保存」ボタンを追加（ログイン済みGoogle認証をそのまま使用、保存済みなら非活性）

## 設計メモ
- Nodeスクリプトから直接Firestoreへ書き込む案（サービスアカウント鍵）も検討したが、鍵の発行・管理が不要な
  「アプリ内ボタン」方式をディレクター判断で採用。将来の定期自動実行（CI/Cloud Functions）に移行する際に
  サービスアカウント方式を再検討する
- レポート生成フローは従来どおり: `node --experimental-strip-types scripts/generate-evaluation-report.ts` でJSON生成
  → アプリの評価画面から保存ボタンでFirestoreへ反映

## 動作確認
- `npm run build`（tsc + vite build）成功を確認
- ルールデプロイ成功を確認（firebase deploy --only firestore）
- 実ブラウザでログイン状態での保存ボタン動作をユーザが確認（2026-07-03）。Firestoreへの保存・表示切り替えともに正常

## ステータス
解決済。評価レポートはFirestore保存方式へ移行完了。
