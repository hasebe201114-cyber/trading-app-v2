import { HelpCircle } from 'lucide-react';

export const HelpButton = ({ k, set }: { k: string; set: (k: string) => void }) => (
  <button
    onClick={() => set(k)}
    className="inline-flex p-1 ml-1 text-fg-3 dark:text-fg-3 hover:text-sprout dark:hover:text-sprout transition align-middle rounded-md hover:bg-surface-2 dark:hover:bg-surface-2"
  >
    <HelpCircle size={16} />
  </button>
);
