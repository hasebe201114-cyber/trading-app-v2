import { Home, LineChart, Radio, BarChart3, TrendingUp, Settings } from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon: typeof Home;
}

// 7層アーキテクチャ（PJ000001参照）の②④⑦にそれぞれ対応する画面
export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'ホーム', icon: Home },
  { path: '/patterns', label: 'パターン分析', icon: LineChart },
  { path: '/signals', label: 'シグナル', icon: Radio },
  { path: '/evaluation', label: '評価', icon: BarChart3 },
  { path: '/forward', label: 'フォワード', icon: TrendingUp },
  { path: '/settings', label: '設定', icon: Settings },
];
