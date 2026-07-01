import { SectionBox } from '../../ui/components/SectionBox';
import { useFontSize, type FontSize } from '../../hooks/useFontSize';

const FONT_SIZE_LABELS: Record<FontSize, string> = {
  small: '小',
  medium: '標準',
  large: '大',
};

export const SettingsScreen = () => {
  const { fontSize, setFontSize } = useFontSize();

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-h1 font-700">設定</h1>

      <SectionBox title="表示設定">
        <div className="flex items-center gap-2">
          <span className="text-body text-fg-2 dark:text-fg-2 mr-2">文字サイズ</span>
          {(Object.keys(FONT_SIZE_LABELS) as FontSize[]).map((size) => (
            <button
              key={size}
              onClick={() => setFontSize(size)}
              className={`px-3 py-1.5 rounded-md text-caption transition ${
                fontSize === size
                  ? 'bg-sprout text-fg-on-accent font-600'
                  : 'border border-line dark:border-line text-fg-2 dark:text-fg-2 hover:bg-surface-2 dark:hover:bg-surface-2'
              }`}
            >
              {FONT_SIZE_LABELS[size]}
            </button>
          ))}
        </div>
      </SectionBox>
    </div>
  );
};
