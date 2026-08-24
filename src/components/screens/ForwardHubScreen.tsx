import { useSearchParams } from 'react-router-dom';
import { ExternalLink, FileText } from 'lucide-react';
import { ForwardCalibrationScreen } from './ForwardCalibrationScreen';
import { VrpForwardScreen } from './VrpForwardScreen';
import { SysFx012ForwardScreen } from './SysFx012ForwardScreen';

// フォワード較正中の実験。追加時はここに1行足せば画面タブが増える。
const EXPERIMENTS = [
  { key: 'carry', label: 'OBS000032 キャリー', color: '#3B82F6' },
  { key: 'vrp', label: 'OBS000037 VRP', color: '#8B5CF6' },
  { key: 'fx-sysfx012', label: 'SYS-FX012 FXフォワード', color: '#F97316' },
] as const;

type ExperimentKey = typeof EXPERIMENTS[number]['key'];

const SCREENS: Record<ExperimentKey, React.ReactNode> = {
  carry: <ForwardCalibrationScreen />,
  vrp: <VrpForwardScreen />,
  'fx-sysfx012': <SysFx012ForwardScreen />,
};

// フォワード画面から直接アクセスできるバックテスト／週次レポート集。
// スマホからのブックマーク運用を前提に、表示中タブに関わらず常にリンクを露出する。
// SYS-FX012 週次レポートは minmax-fx-day-trading-lab 側の build_weekly_html.py で
// 毎週月曜 10:00 JST に上書き push される (LATEST 固定 URL)。
const WEEKLY_REPORTS = [
  {
    key: 'sysfx012',
    title: 'SYS-FX012 週次レポート (LATEST)',
    description: 'FX フォワードテスト週次サマリ・チャート・チェックポイント進捗',
    url: '/reports/sysfx012-weekly-LATEST.html',
    color: '#F97316',
  },
  {
    key: 'carry',
    title: 'OBS000032 キャリー バックテスト',
    description: 'BTC キャリー戦略 Stage 2 検証 (採用 GO 時点の固定レポート)',
    url: '/reports/obs000032-carry-backtest.html',
    color: '#3B82F6',
  },
  {
    key: 'vrp',
    title: 'OBS000037 VRP バックテスト',
    description: 'Deribit VRP 戦略 Stage 2 検証 (週次 276 点・全期間)',
    url: '/reports/obs000037-vrp-backtest.html',
    color: '#8B5CF6',
  },
] as const;

/**
 * フォワード較正モニターのハブ画面。
 * 稼働中の3実験（OBS000032キャリー / OBS000037 VRP / SYS-FX012 FXフォワード）を1画面で切り替える。
 * 選択状態は `?exp=vrp` としてURLに載せるため、スマホからのブックマーク・共有で直接開ける。
 * 直下に「最新レポート」セクションを常設し、SYS-FX012 週次レポート (LATEST) を含む
 * 関連レポートへ1タップで遷移できるようにする。
 */
export const ForwardHubScreen = () => {
  const [params, setParams] = useSearchParams();
  const raw = params.get('exp');
  const active: ExperimentKey = EXPERIMENTS.some(e => e.key === raw) ? (raw as ExperimentKey) : 'carry';

  return (
    <div>
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="flex gap-2 overflow-x-auto">
          {EXPERIMENTS.map(e => (
            <button
              key={e.key}
              onClick={() => setParams(e.key === 'carry' ? {} : { exp: e.key }, { replace: true })}
              className={`px-4 py-1.5 rounded text-sm font-600 border transition-colors whitespace-nowrap ${
                active === e.key ? 'text-white' : 'border-fg-3 text-fg-2 hover:border-fg-2'
              }`}
              style={active === e.key ? { backgroundColor: e.color, borderColor: e.color } : undefined}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>

      <section className="px-4 sm:px-6 pt-3 pb-1">
        <h3 className="text-[11px] font-700 text-fg-3 mb-1.5 tracking-wider">最新レポート</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {WEEKLY_REPORTS.map(r => (
            <a
              key={r.key}
              href={r.url}
              className="flex items-start gap-2 px-3 py-2.5 rounded border border-fg-3/60 hover:shadow-sm transition-shadow bg-white"
              style={{ borderLeftWidth: '3px', borderLeftColor: r.color }}
            >
              <FileText size={15} className="shrink-0 mt-0.5" style={{ color: r.color }} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-700 text-fg-1">{r.title}</div>
                <div className="text-[10px] text-fg-3 mt-0.5 leading-relaxed">{r.description}</div>
              </div>
              <ExternalLink size={11} className="shrink-0 mt-1 text-fg-3" />
            </a>
          ))}
        </div>
      </section>

      {SCREENS[active]}
    </div>
  );
};
