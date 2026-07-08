import { SectionBox } from '../../ui/components/SectionBox';
import { MetricCard } from '../../ui/components/MetricCard';
import { ProjectStatusBoard } from '../dashboard/ProjectStatusBoard';

export const HomeScreen = () => (
  <div className="p-6 space-y-6">
    <h1 className="text-h1 font-700">ホーム</h1>
    <p className="text-body text-fg-2 dark:text-fg-2">
      trading-app-v2 のプロジェクト進捗ダッシュボード。実験の採否・進行状況をリアルタイム表示。
    </p>

    <SectionBox title="プロジェクトの現在地">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard color="blue" label="フェーズ" value="Phase 0" sub="フォワード較正" />
        <MetricCard color="purple" label="進行中" value="OBS000032" sub="Day90カウントダウン中" />
        <MetricCard color="emerald" label="採用済み" value="3戦略" sub="本番反映済み" />
      </div>
    </SectionBox>

    <ProjectStatusBoard />
  </div>
);
