import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './navItems';

export const MobileTabBar = () => (
  <div className="flex h-full">
    {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
      <NavLink
        key={path}
        to={path}
        end={path === '/'}
        className={({ isActive }) =>
          `flex-1 flex flex-col items-center justify-center gap-0.5 text-micro transition ${
            isActive ? 'text-sprout dark:text-sprout' : 'text-fg-3 dark:text-fg-3'
          }`
        }
      >
        <Icon size={20} />
        {label}
      </NavLink>
    ))}
  </div>
);
