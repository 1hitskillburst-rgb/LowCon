import React, { useEffect } from 'react';
import { BookOpen, X } from 'lucide-react';

interface SourcesModalProps {
  sources: string[] | null;
  onClose: () => void;
}

export const SourcesModal: React.FC<SourcesModalProps> = ({ sources, onClose }) => {
  useEffect(() => {
    if (!sources) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [sources, onClose]);

  if (!sources) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sources-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
    >
      <div className="w-full max-w-[480px] rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--lc-surf-line)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-[var(--lc-accent)]" />
            <h2 id="sources-modal-title" className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
              Sources & Memory References
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sources dialog"
            className="rounded p-1 text-[var(--lc-surf-mute)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2 px-5 py-4">
          {sources.map((src, idx) => (
            <div
              key={`${idx}-${src}`}
              className="rounded-[6px] border border-[var(--lc-line)] bg-[var(--lc-bg)] px-3 py-2 text-[13px] text-[var(--lc-ink)]"
            >
              {src}
            </div>
          ))}
        </div>
        <div className="flex justify-end border-t border-[var(--lc-surf-line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] bg-[var(--lc-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
