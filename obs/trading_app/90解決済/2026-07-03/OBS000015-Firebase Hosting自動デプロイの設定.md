# OBS000015 - Firebase Hosting 自動デプロイの設定

## 変更履歴
- 2026-07-02: 起票・実装。シークレット登録（ユーザ作業）待ち
- 2026-07-03: シークレット判定ステップをenv経由に修正（複数行JSONでのシェル構文エラー防止）
- 2026-07-03: ユーザによるシークレット登録後、run #2で本番デプロイ成功を確認。解決済へ移動（リンクも修正）

## 関連ドキュメント
- [OBS000013-評価レポートFirestore保存方式への移行.md](OBS000013-評価レポートFirestore保存方式への移行.md)（Firebase接続完了を受けて本番デプロイ経路の整備が可能になった）

## 背景
- CLAUDE.mdの方針は「ビルドはGitHub autoにて実施」だが、既存CI（build.yml）はビルド検証のみで、本番（Firebase Hosting）への反映はローカルPCからの `firebase deploy` 手動実行が必要だった
- スマホからの指示が多い運用のため、mainへのマージだけで本番反映される経路が望ましい

## 実装内容
- `.github/workflows/deploy.yml` 新規: mainへのpush時に ビルド → Firebase Hosting(live) へデプロイ
  - `FirebaseExtended/action-hosting-deploy@v0` を使用、プロジェクトは `trading-app-v2-94de8`
  - **シークレット `FIREBASE_SERVICE_ACCOUNT` が未設定の間はデプロイをスキップ**（警告表示のみ、ビルド検証は実施）し、CIを赤くしない
- `.github/workflows/build.yml` 変更: PR・作業ブランチ専用に変更（mainはdeploy.ymlがビルドするため二重ビルドを回避）

## ユーザ作業（シークレット登録・初回のみ）
1. [Google Cloudコンソールのサービスアカウント一覧](https://console.cloud.google.com/iam-admin/serviceaccounts?project=trading-app-v2-94de8) を開く
2. `firebase-adminsdk-...@trading-app-v2-94de8.iam.gserviceaccount.com` を選択 → 「キー」タブ → 「鍵を追加」→「新しい鍵を作成」→ JSON でダウンロード
3. GitHubリポジトリ `hasebe201114-cyber/trading-app-v2` → Settings → Secrets and variables → Actions → 「New repository secret」
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: ダウンロードしたJSONファイルの中身を全文貼り付け
4. 以後、mainへのpushで自動的に `https://trading-app-v2-94de8.web.app` へデプロイされる
   - 登録後すぐ反映したい場合は、GitHubのActionsタブから「Deploy to Firebase Hosting」を選び直近の実行を「Re-run all jobs」

## セキュリティ留意事項
- サービスアカウントのJSONキーは秘密情報。GitHub Secrets以外の場所（リポジトリ内・チャット等）に貼らないこと
- ダウンロードしたJSONファイルは登録後にPCから削除してよい

## ステータス
解決済（2026-07-03）。GitHub Actions run #2 にて「Deploy to Firebase Hosting (live)」ステップの成功を確認。
以後、mainへのpushで自動的に https://trading-app-v2-94de8.web.app に本番反映される。
なお初回デプロイ前に「Site Not Found」が表示されていたのは未デプロイ状態が原因であり、ビルド失敗ではなかった。
