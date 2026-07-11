import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './hooks/useAuth';
import { AppShell } from './components/shell/AppShell';
import { HomeScreen } from './components/screens/HomeScreen';
import { PatternAnalysisScreen } from './components/screens/PatternAnalysisScreen';
import { SignalsScreen } from './components/screens/SignalsScreen';
import { EvaluationScreen } from './components/screens/EvaluationScreen';
import { ForwardCalibrationScreen } from './components/screens/ForwardCalibrationScreen';
import { CarryExecutorScreen } from './components/screens/CarryExecutorScreen';
import { SettingsScreen } from './components/screens/SettingsScreen';

const queryClient = new QueryClient();

function App() {
  const { user, isAllowed, error, signIn } = useAuth();

  if (user === undefined) {
    // 認証状態判定中は何も描画しない（チラつき防止）
    return <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }} />;
  }

  if (!user || !isAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="text-center">
          <h1 className="text-h1 font-700 mb-4" style={{ color: 'var(--fg-1)' }}>Trading App</h1>
          {error && <p className="text-caption mb-4" style={{ color: 'var(--short)' }}>{error}</p>}
          <button
            onClick={signIn}
            className="px-6 py-3 rounded-md font-600"
            style={{ backgroundColor: 'var(--sprout)', color: 'var(--fg-on-accent)' }}
          >
            Googleでログイン
          </button>
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomeScreen />} />
            <Route path="/patterns" element={<PatternAnalysisScreen />} />
            <Route path="/signals" element={<SignalsScreen />} />
            <Route path="/evaluation" element={<EvaluationScreen />} />
            <Route path="/forward" element={<ForwardCalibrationScreen />} />
            <Route path="/carry-executor" element={<CarryExecutorScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
