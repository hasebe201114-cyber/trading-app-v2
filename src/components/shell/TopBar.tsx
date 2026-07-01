import { useAuth } from '../../hooks/useAuth';

export const TopBar = () => {
  const { user, signOut } = useAuth();

  return (
    <div className="flex items-center justify-end h-full px-6 gap-4">
      {user?.email && (
        <span className="text-caption text-fg-2 dark:text-fg-2">{user.email}</span>
      )}
      <button
        onClick={signOut}
        className="text-caption px-3 py-1.5 rounded-md border border-line dark:border-line text-fg-2 dark:text-fg-2 hover:bg-surface-2 dark:hover:bg-surface-2 transition"
      >
        ログアウト
      </button>
    </div>
  );
};
