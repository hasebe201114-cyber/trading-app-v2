import { SectionBox } from '../../ui/components/SectionBox';
import { ConfRing } from '../../components/atoms/ConfRing';
import { InfoRow } from '../../ui/components/InfoRow';

export const PatternAnalysisScreen = () => (
  <div className="p-6 space-y-6">
    <h1 className="text-h1 font-700">パターン分析</h1>
    <p className="text-body text-fg-2 dark:text-fg-2">
      ②パターン認識・統計シグナル層（PJ000001参照）の出力を表示する画面です。まだエンジン本体は未実装のため、
      表示コンポーネントのプレビューのみ置いています。
    </p>

    <SectionBox title="表示コンポーネントのプレビュー（サンプル値）">
      <div className="flex items-center gap-8 flex-wrap">
        <ConfRing value={0} label="確度（未算出）" />
      </div>
      <div className="max-w-xs mt-4">
        <InfoRow label="方向" value="未算出" />
        <InfoRow label="強さ" value="未算出" />
        <InfoRow label="類似パターン件数" value="未算出" />
      </div>
    </SectionBox>
  </div>
);
