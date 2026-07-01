import { SectionBox } from '../../ui/components/SectionBox';
import { InfoRow } from '../../ui/components/InfoRow';

interface KpiRow {
  layer: string;
  metric: string;
  target: string;
}

// PJ000001 4.1節・5.3節の目標値をそのまま反映（実績は各層の実装完了後に接続）
const KPI_ROWS: KpiRow[] = [
  { layer: '②パターン認識層', metric: '方向的中率', target: '55%以上' },
  { layer: '③LLM特徴量層', metric: 'イベント検知的中率', target: '60%以上' },
  { layer: '③LLM特徴量層', metric: 'シャープレシオ増分寄与', target: '+0.2以上' },
  { layer: '④統合判断層', metric: '②単体との成績差分', target: '常に②を上回る' },
  { layer: '⑤リスク管理層', metric: '最大ドローダウン', target: '15%以内' },
];

export const EvaluationScreen = () => (
  <div className="p-6 space-y-6">
    <h1 className="text-h1 font-700">評価</h1>
    <p className="text-body text-fg-2 dark:text-fg-2">
      ⑦評価・チューニング層（PJ000001参照）のダッシュボード土台です。バックテスト/フォワードテストの実行結果が
      蓄積され次第、「実績」列を接続します。
    </p>

    <SectionBox title="層別KPI 目標値">
      <div className="max-w-lg">
        {KPI_ROWS.map((row) => (
          <InfoRow
            key={`${row.layer}-${row.metric}`}
            label={`${row.layer} / ${row.metric}`}
            value={row.target}
          />
        ))}
      </div>
    </SectionBox>
  </div>
);
