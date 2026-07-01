import { HelpButton } from './HelpButton';

export const InfoRow = ({
  label, value, vClass, hk, set,
}: { label: string; value: string; vClass?: string; hk?: string; set?: (k: string) => void }) => (
  <div className="flex justify-between items-center text-caption py-0.5">
    <span className="text-fg-2 dark:text-fg-2 flex items-center gap-0.5">
      {label}
      {hk && set && <HelpButton k={hk} set={set} />}
    </span>
    <span className={`font-mono ${vClass ?? 'text-fg-1 dark:text-fg-1'}`}>{value}</span>
  </div>
);
