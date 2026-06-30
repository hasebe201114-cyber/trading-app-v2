import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './hooks/useAuth';

const queryClient = new QueryClient();

function App() {
  const { user, isAllowed, error, signIn } = useAuth();

  return (
    <QueryClientProvider client={queryClient}>
      {user === undefined ? (
        // 認証状態判定中は何も描画しない（チラつき防止）
        <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }} />
      ) : !user || !isAllowed ? (
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
      ) : (
        <div className="min-h-screen p-6" style={{ backgroundColor: 'var(--bg)', color: 'var(--fg-1)' }}>
          <h1 className="text-h1 font-700">Trading App へようこそ</h1>
          <p className="text-body mt-2" style={{ color: 'var(--fg-2)' }}>
            ここから機能を組み立てていきます。
          </p>
        </div>
      )}
    </QueryClientProvider>
  );
}

export default App;
