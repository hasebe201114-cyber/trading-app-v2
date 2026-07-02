import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionBox } from '../../ui/components/SectionBox';
import { InfoRow } from '../../ui/components/InfoRow';
import { MetricCard } from '../../ui/components/MetricCard';
import {
  EvaluationReport,
  fetchLatestEvaluationReport,
  saveEvaluationReport,
} from '../../lib/evaluationReports';
import localReport from '../../data/evaluationReport.json';

interface KpiRow {
  layer: string;
  metric: string;
  target: string;
}

// まだ実測できていない項目（③実LLM化・④統合効果の単体比較等）の目標値
const PENDING_KPI_ROWS: KpiRow[] = [
  { layer: '③LLM特徴量層', metric: 'イベント検知的中率', target: '60%以上（実LLM未接続のため未測定）' },
  { layer: '③LLM特徴量層', metric: 'シャープレシオ増分寄与', target: '+0.2以上（実LLM未接続のため未測定）' },
  { layer: '④統合判断層', metric: '②単体との成績差分', target: '常に②を上回る（③が実装されてから比較意義あり）' },
];

const bundledReport = localReport as EvaluationReport;

export const EvaluationScreen = () => {
  const queryClient = useQueryClient();

  const reportQuery = useQuery({
    queryKey: ['evaluationReport', 'latest'],
    queryFn: fetchLatestEvaluationReport,
  });

  const saveMutation = useMutation({
    mutationFn: () => saveEvaluationReport(bundledReport),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['evaluationReport'] }),
  });

  if (reportQuery.isLoading) {
    return (
      <div className="p-6">
        <h1 className="text-h1 font-700">評価</h1>
        <p className="text-body text-fg-2 dark:text-fg-2 mt-4">評価レポートを読み込み中…</p>
      </div>
    );
  }

  // Firestore に保存済みの最新レポートを優先し、無ければビルド同梱スナップショットを表示
  const firestoreReport = reportQuery.data ?? null;
  const report = firestoreReport ?? bundledReport;
  const isFromFirestore = firestoreReport !== null;
  const bundledIsSaved = firestoreReport?.generatedAt === bundledReport.generatedAt;

  const { summary, folds, targets, caveats, generatedAt, dataSource } = report;
  const sharpeAchieved = summary.foldsAboveSharpeTarget === summary.totalFolds;
  const ddAchieved = summary.foldsWithinDrawdownTarget === summary.totalFolds;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-h1 font-700">評価</h1>
      <p className="text-body text-fg-2 dark:text-fg-2">
        ⑦評価・チューニング層（PJ000001参照）。②③④⑤⑥を統合したパイプラインを実データ（BTC日足）で
        バックテストした結果です。
      </p>

      <SectionBox title="レポートデータソース">
        <div className="space-y-2">
          <p className="text-caption text-fg-2 dark:text-fg-2">
            表示中: {isFromFirestore ? 'Firestore（保存済みレポート）' : 'ビルド同梱スナップショット（Firestore未保存）'}
          </p>
          {reportQuery.isError && (
            <p className="text-caption" style={{ color: 'var(--short)' }}>
              Firestoreからの読み込みに失敗したため、ビルド同梱スナップショットを表示しています:{' '}
              {String(reportQuery.error)}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={bundledIsSaved || saveMutation.isPending}
              className="px-4 py-2 rounded-md font-600 text-caption disabled:opacity-50"
              style={{ backgroundColor: 'var(--sprout)', color: 'var(--fg-on-accent)' }}
            >
              {saveMutation.isPending ? '保存中…' : 'スナップショットをFirestoreへ保存'}
            </button>
            {bundledIsSaved && (
              <span className="text-caption text-fg-3 dark:text-fg-3">同梱スナップショットは保存済みです</span>
            )}
            {saveMutation.isError && (
              <span className="text-caption" style={{ color: 'var(--short)' }}>
                保存に失敗しました: {String(saveMutation.error)}
              </span>
            )}
          </div>
        </div>
      </SectionBox>

      <SectionBox title="パイプライン検証サマリー（5フォールド）">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            color={sharpeAchieved ? 'emerald' : 'amber'}
            label="平均シャープレシオ"
            value={summary.avgSharpeRatio.toFixed(2)}
            sub={`目標${targets.sharpeRatio}以上 / 達成${summary.foldsAboveSharpeTarget}/${summary.totalFolds}フォールド`}
          />
          <MetricCard
            color={summary.minSharpeRatio >= targets.sharpeRatio ? 'emerald' : 'red'}
            label="最小シャープレシオ"
            value={summary.minSharpeRatio.toFixed(2)}
            sub="直近フォールドが最も低い傾向"
          />
          <MetricCard
            color={ddAchieved ? 'emerald' : 'red'}
            label="最大ドローダウン(全期間中)"
            value={`${(summary.maxDrawdownAcrossFolds * 100).toFixed(1)}%`}
            sub={`目標${(targets.maxDrawdown * 100).toFixed(0)}%以内`}
          />
          <MetricCard
            color="blue"
            label="DD目標達成フォールド"
            value={`${summary.foldsWithinDrawdownTarget}/${summary.totalFolds}`}
            sub="全フォールドで15%以内を維持"
          />
        </div>
      </SectionBox>

      <SectionBox title="フォールド別実績">
        <div className="overflow-x-auto">
          <table className="w-full text-caption">
            <thead>
              <tr className="text-fg-3 dark:text-fg-3 text-left border-b border-line dark:border-line">
                <th className="py-2 pr-4">期間</th>
                <th className="py-2 pr-4">トレード数</th>
                <th className="py-2 pr-4">勝率</th>
                <th className="py-2 pr-4">総リターン</th>
                <th className="py-2 pr-4">最大DD</th>
                <th className="py-2 pr-4">シャープレシオ</th>
              </tr>
            </thead>
            <tbody>
              {folds.map((f) => (
                <tr key={f.label} className="border-b border-line dark:border-line last:border-0">
                  <td className="py-2 pr-4 text-fg-1 dark:text-fg-1">{f.label}</td>
                  <td className="py-2 pr-4 font-mono">{f.tradeCount}</td>
                  <td className="py-2 pr-4 font-mono">{(f.winRate * 100).toFixed(1)}%</td>
                  <td className="py-2 pr-4 font-mono">{(f.totalReturn * 100).toFixed(1)}%</td>
                  <td className="py-2 pr-4 font-mono">{(f.maxDrawdown * 100).toFixed(1)}%</td>
                  <td className={`py-2 pr-4 font-mono ${f.sharpeRatio >= targets.sharpeRatio ? 'text-long' : 'text-short'}`}>
                    {f.sharpeRatio.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionBox>

      <SectionBox title="未測定のKPI">
        <div className="max-w-lg">
          {PENDING_KPI_ROWS.map((row) => (
            <InfoRow key={`${row.layer}-${row.metric}`} label={`${row.layer} / ${row.metric}`} value={row.target} />
          ))}
        </div>
      </SectionBox>

      <SectionBox title="注意事項">
        <ul className="list-disc list-inside space-y-1 text-caption text-fg-2 dark:text-fg-2">
          {caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="text-micro text-fg-3 dark:text-fg-3 mt-2">
          データソース: {dataSource}<br />
          レポート生成日時: {new Date(generatedAt).toLocaleString('ja-JP')}
        </p>
      </SectionBox>
    </div>
  );
};
