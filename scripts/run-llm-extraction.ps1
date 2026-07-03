# ③LLM特徴量抽出の自動実行スクリプト
# 使い方: .\scripts\run-llm-extraction.ps1 -ApiKey "sk-ant-..."

param(
    [Parameter(Mandatory=$true, HelpMessage="Anthropic API Key (sk-ant-...)")]
    [string]$ApiKey
)

# APIキーを環境変数に設定
$env:ANTHROPIC_API_KEY = $ApiKey

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "③LLM特徴量抽出バッチ（Phase 2 KPI検証）" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# ステップ1: 小規模テスト（5日分）
Write-Host "【ステップ1】小規模テスト実行（5日分）" -ForegroundColor Green
Write-Host "API呼び出し: 約5回、コスト: <$1" -ForegroundColor Yellow
Write-Host ""
node --experimental-strip-types scripts/llm-feature-extraction.ts --limit 5

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ ステップ1で失敗しました。APIキーを確認してください。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "【ステップ2】全期間実行（2021-2026, 約2,000日）" -ForegroundColor Green
Write-Host "API呼び出し: 約2,000回、推定コスト: $4（Claude Haiku）" -ForegroundColor Yellow
Write-Host "※ 処理時間: 10～30分程度" -ForegroundColor Cyan
Write-Host ""

$confirmInput = Read-Host "本実行を進めますか？ (y/n)"
if ($confirmInput -ne "y" -and $confirmInput -ne "Y") {
    Write-Host "中止しました。" -ForegroundColor Yellow
    exit 0
}

node --experimental-strip-types scripts/llm-feature-extraction.ts

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ ステップ2で失敗しました。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "【ステップ3】③あり/なし比較バックテスト（Phase 2 KPI判定）" -ForegroundColor Green
Write-Host ""
node --experimental-strip-types scripts/pipeline-backtest-llm.ts

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️ ステップ3で失敗しました。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "===============================================" -ForegroundColor Green
Write-Host "✅ すべての処理が完了しました" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""
Write-Host "結果ファイル:" -ForegroundColor Cyan
Write-Host "  - llm-features-daily.live.json (LLM特徴量キャッシュ)" -ForegroundColor Gray
Write-Host ""
Write-Host "次のステップ:" -ForegroundColor Cyan
Write-Host "  1. コンソール出力の③あり/なし比較結果を確認" -ForegroundColor Gray
Write-Host "  2. シャープレシオの改善度を確認" -ForegroundColor Gray
Write-Host "  3. 結果を obs/trading_app/80実装中/OBS000014 に追記" -ForegroundColor Gray
