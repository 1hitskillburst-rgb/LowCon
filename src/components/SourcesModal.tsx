import React from 'react';
import { BookOpen, X } from 'lucide-react';

interface SourcesModalProps {
  sources: string[] | null;
  onClose: () => void;
}

export const SourcesModal: React.FC<SourcesModalProps> = ({ sources, onClose }) => {
  if (!sources) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sources-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
    >
      <div className="w-full max-w-[480px] rounded-[10px] border border-[#D3D8DF] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#D3D8DF] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-[#2A3FE0]" />
            <h2 id="sources-modal-title" className="text-[15px] font-bold text-[#161B26]">
              Sources & Memory References
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sources dialog"
            className="rounded p-1 text-[#778091] hover:bg-[#E8EBEF] hover:text-[#161B26]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2 px-5 py-4">
          {sources.map((src, idx) => (
            <div
              key={`${idx}-${src}`}
              className="rounded-[6px] border border-[#D3D8DF] bg-[#F7F8F9] px-3 py-2 text-[13px] text-[#161B26]"
            >
              {src}
            </div>
          ))}
        </div>
        <div className="flex justify-end border-t border-[#D3D8DF] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] bg-[#161B26] px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-[#2A3FE0]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
