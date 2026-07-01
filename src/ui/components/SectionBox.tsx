import React from 'react';

interface SectionBoxProps {
  children: React.ReactNode;
  title?: string;
  icon?: React.ReactNode;
  className?: string;
}

export const SectionBox: React.FC<SectionBoxProps> = ({
  children,
  title,
  icon,
  className = '',
}) => {
  return (
    <div className={`space-y-3 ${className}`}>
      {title && (
        <div className="flex items-center gap-2 px-1 py-2 pb-2 border-b-2 border-sprout dark:border-sprout">
          {icon && (
            <div className="text-sprout dark:text-sprout flex items-center">
              {icon}
            </div>
          )}
          <h3 className="text-caption font-600 uppercase tracking-wider text-fg-1 dark:text-fg-1">{title}</h3>
        </div>
      )}
      <div className="space-y-3">
        {children}
      </div>
    </div>
  );
};
