import { SectionBox } from '../../ui/components/SectionBox';
import { MetricCard } from '../../ui/components/MetricCard';

export const HomeScreen = () => (
  <div className="p-6 space-y-6">
    <h1 className="text-h1 font-700">ホーム</h1>
    <p className="text-body text-fg-2 dark:text-fg-2">
      trading-app-v2 のダッシュボードです。各層の実装が進むにつれて、ここに集計サマリーを表示していきます。
    </p>

    <SectionBox title="プロジェクトの現在地">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard color="blue" label="フェーズ" value="Phase 0" sub="アプリ基盤構築" />
        <MetricCard color="purple" label="パターン認識層" value="未着手" sub="Phase 1 で着手予定" />
        <MetricCard color="amber" label="評価層" value="設計中" sub="PJ000001参照" />
      </div>
    </SectionBox>
  </div>
);
