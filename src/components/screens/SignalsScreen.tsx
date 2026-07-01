import { SectionBox } from '../../ui/components/SectionBox';

export const SignalsScreen = () => (
  <div className="p-6 space-y-6">
    <h1 className="text-h1 font-700">シグナル</h1>
    <p className="text-body text-fg-2 dark:text-fg-2">
      ④統合判断層（PJ000001参照）が生成する最終シグナル（方向・確度・推奨ポジションサイズ）の一覧を表示する画面です。
      ②③層の実装が完了次第、ここに接続します。
    </p>

    <SectionBox title="シグナル一覧">
      <p className="text-caption text-fg-3 dark:text-fg-3">まだシグナルはありません。</p>
    </SectionBox>
  </div>
);
