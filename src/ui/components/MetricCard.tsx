import { HelpButton } from './HelpButton';

type MetricColor = 'emerald' | 'blue' | 'amber' | 'red' | 'purple' | 'cyan';

const COLOR_MAP: Record<MetricColor, { bg: string; border: string; text: string; sub: string }> = {
  emerald: { bg: 'from-long/10 dark:from-long/10 to-long/5 dark:to-long/5',     border: 'border-long/30 dark:border-long/30', text: 'text-long dark:text-long',        sub: 'text-long/60 dark:text-long/60' },
  blue:    { bg: 'from-info/10 dark:from-info/10 to-info/5 dark:to-info/5',     border: 'border-info/30 dark:border-info/30', text: 'text-info dark:text-info',       sub: 'text-info/60 dark:text-info/60' },
  amber:   { bg: 'from-warn/10 dark:from-warn/10 to-warn/5 dark:to-warn/5',     border: 'border-warn/30 dark:border-warn/30', text: 'text-warn dark:text-warn',       sub: 'text-warn/60 dark:text-warn/60' },
  red:     { bg: 'from-short/10 dark:from-short/10 to-short/5 dark:to-short/5', border: 'border-short/30 dark:border-short/30', text: 'text-short dark:text-short',     sub: 'text-short/60 dark:text-short/60' },
  purple:  { bg: 'from-sprout/10 dark:from-sprout/10 to-sprout/5 dark:to-sprout/5', border: 'border-sprout/30 dark:border-sprout/30', text: 'text-sprout dark:text-sprout', sub: 'text-sprout/60 dark:text-sprout/60' },
  cyan:    { bg: 'from-info/10 dark:from-info/10 to-sprout/5 dark:to-sprout/5',     border: 'border-info/30 dark:border-info/30', text: 'text-info dark:text-info',       sub: 'text-info/60 dark:text-info/60' },
};

export const MetricCard = ({
  color, label, value, unit, sub, hk, set,
}: { color: MetricColor; label: string; value: number | string; unit?: string; sub: string; hk?: string; set?: (k: string) => void }) => {
  const c = COLOR_MAP[color];
  return (
    <div className={`bg-gradient-to-br ${c.bg} rounded-xl p-4 border ${c.border}`}>
      <div className={`text-xs font-semibold ${c.text} uppercase tracking-wider flex items-center`}>
        {label}
        {hk && set && <HelpButton k={hk} set={set} />}
      </div>
      <div className={`text-3xl font-bold font-mono ${c.text} mt-2`}>{value}{unit}</div>
      <div className={`text-xs ${c.sub} mt-1`}>{sub}</div>
    </div>
  );
};
