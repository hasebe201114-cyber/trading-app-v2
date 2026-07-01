import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './navItems';

export const Sidebar = ({ onClose }: { onClose?: () => void }) => (
  <div className="flex flex-col h-full p-4">
    <div className="flex items-center gap-2 px-2 py-3 text-sprout dark:text-sprout">
      <span className="text-h3 font-700 tracking-tight text-fg-1 dark:text-fg-1">Trading App</span>
    </div>
    <nav className="flex-1 mt-4 space-y-1">
      {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
        <NavLink
          key={path}
          to={path}
          end={path === '/'}
          onClick={onClose}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-md text-body transition ${
              isActive
                ? 'bg-sprout-100 dark:bg-sprout-100 text-sprout-700 dark:text-sprout-700 font-600'
                : 'text-fg-2 dark:text-fg-2 hover:bg-surface-2 dark:hover:bg-surface-2'
            }`
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  </div>
);
