import React from 'react';
import { X } from 'lucide-react';

export const HelpModal = ({ title, content, onClose }: { title: string; content: string; onClose: () => void }) => (
  <div
    className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    onClick={onClose}
  >
    <div
      className="bg-surface dark:bg-surface rounded-lg p-6 max-w-sm w-full border border-line dark:border-line"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-h3 font-600 text-fg-1 dark:text-fg-1 leading-tight">{title}</h3>
        <button onClick={onClose} className="text-fg-3 dark:text-fg-3 hover:text-fg-1 dark:hover:text-fg-1 transition ml-3 flex-shrink-0">
          <X size={18} />
        </button>
      </div>
      <p className="text-caption text-fg-2 dark:text-fg-2 leading-relaxed">{content}</p>
    </div>
  </div>
);
