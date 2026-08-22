import { useSearchParams } from 'react-router-dom';
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

/**
 * フォワード較正モニターのハブ画面。
 * 稼働中の3実験（OBS000032キャリー / OBS000037 VRP / SYS-FX012 FXフォワード）を1画面で切り替える。
 * 選択状態は `?exp=vrp` としてURLに載せるため、スマホからのブックマーク・共有で直接開ける。
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
      {SCREENS[active]}
    </div>
  );
};
