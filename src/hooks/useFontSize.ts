import { useState, useEffect } from 'react';

export type FontSize = 'small' | 'medium' | 'large';

const FONT_SIZE_KEY = 'trading-app-v2-font-size';

export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSize>('medium');

  // 初期化時にローカルストレージから読み込み
  useEffect(() => {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored === 'small' || stored === 'medium' || stored === 'large') {
      setFontSizeState(stored);
    }
  }, []);

  const setFontSize = (size: FontSize) => {
    setFontSizeState(size);
    localStorage.setItem(FONT_SIZE_KEY, size);
  };

  // フォントサイズに応じたクラスのマッピング
  const getTextClass = (baseClass: string): string => {
    // baseClass が text-xs, text-sm, text-base, text-lg などを想定
    // fontSize で1段階上下する
    const classMap: Record<string, Record<FontSize, string>> = {
      'text-xs': { small: 'text-xs', medium: 'text-xs', large: 'text-sm' },
      'text-sm': { small: 'text-xs', medium: 'text-sm', large: 'text-base' },
      'text-base': { small: 'text-sm', medium: 'text-base', large: 'text-lg' },
      'text-lg': { small: 'text-base', medium: 'text-lg', large: 'text-xl' },
      'text-xl': { small: 'text-lg', medium: 'text-xl', large: 'text-2xl' },
    };

    return classMap[baseClass]?.[fontSize] || baseClass;
  };

  // フォントサイズに応じた相対値（1.0 = 標準、1.125 = 大、0.875 = 小）
  const getFontMultiplier = (): number => {
    switch (fontSize) {
      case 'small':
        return 0.875;
      case 'large':
        return 1.125;
      case 'medium':
      default:
        return 1.0;
    }
  };

  return { fontSize, setFontSize, getTextClass, getFontMultiplier };
}
