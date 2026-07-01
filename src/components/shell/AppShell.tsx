import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { MobileTabBar } from './MobileTabBar';
import { useWindowSize } from '../../hooks/useWindowSize';
import { formatDeployTime } from '../../utils/formatDeployTime';

export const AppShell: React.FC = () => {
  const { isMobile } = useWindowSize();
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  return (
    <div className="flex h-screen overflow-hidden bg-bg dark:bg-bg text-fg-1 dark:text-fg-1">
      {/* デスクトップサイドバー */}
      {!isMobile && (
        <aside className="w-64 border-r border-line dark:border-line bg-surface dark:bg-surface overflow-y-auto flex-shrink-0">
          <Sidebar />
        </aside>
      )}

      {/* モバイルサイドバー（オーバーレイ） */}
      {isMobile && sidebarOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="fixed left-0 top-0 h-screen w-64 bg-surface dark:bg-surface border-r border-line dark:border-line overflow-y-auto z-50">
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </aside>
        </>
      )}

      {/* メインコンテンツ */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* デスクトップ上部バー */}
        {!isMobile && (
          <header className="border-b border-line dark:border-line bg-surface dark:bg-surface h-16 flex-shrink-0">
            <TopBar />
          </header>
        )}

        {/* モバイル上部バー */}
        {isMobile && (
          <header className="border-b border-line bg-surface h-14 flex-shrink-0 flex items-center gap-3 px-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 rounded-md text-fg-2 hover:bg-surface-2 transition flex-shrink-0"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="6" x2="17" y2="6"/>
                <line x1="3" y1="10" x2="17" y2="10"/>
                <line x1="3" y1="14" x2="17" y2="14"/>
              </svg>
            </button>
            <div className="flex items-center gap-2 text-sprout">
              <span className="text-h3 font-bold tracking-tight text-fg-1">Trading App</span>
              {import.meta.env.VITE_DEPLOY_TIME && (
                <span className="text-xs font-mono opacity-40 text-fg-3">
                  {formatDeployTime(import.meta.env.VITE_DEPLOY_TIME)}
                </span>
              )}
            </div>
          </header>
        )}

        {/* コンテンツエリア */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>

        {/* モバイルタブバー */}
        {isMobile && (
          <nav className="border-t border-line dark:border-line bg-surface dark:bg-surface h-16 flex-shrink-0">
            <MobileTabBar />
          </nav>
        )}
      </div>
    </div>
  );
};
