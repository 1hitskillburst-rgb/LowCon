import React from 'react';
import type {
  ContextSegmentKey,
  MemoryNote,
  TurnContextBudget,
  WorkspaceFile,
} from '../../core/types';
import { ContextPanel } from './ContextPanel';
import { FilesPanel } from './FilesPanel';

export type RightSidebarTab = 'context' | 'files';

interface RightSidebarPanelProps {
  activeTab: RightSidebarTab;
  onSelectTab: (tab: RightSidebarTab) => void;
  // Context panel props
  budget: TurnContextBudget;
  previewWarning?: string | null;
  taskGoal?: string;
  onUpdateTaskGoal: (goal: string) => void;
  memoryNotes: MemoryNote[];
  includedMemoryIds: string[];
  memoryRetrievalEnabled: boolean;
  onToggleMemoryRetrieval: (enabled: boolean) => void;
  hoveredSegment: ContextSegmentKey | null;
  onHoverSegment: (key: ContextSegmentKey | null) => void;
  onOpenPromptInspector: () => void;
  // Files panel props
  workspaceFiles: WorkspaceFile[];
  allowAiFileEdits: boolean;
  onUploadWorkspaceFiles: (items: Array<{ filename: string; content: string }>) => void;
  onToggleWorkspaceFileLock: (fileId: string, locked: boolean) => void;
  onDeleteWorkspaceFile: (fileId: string) => void;
  onPreviewWorkspaceFile: (file: WorkspaceFile) => void;
  onOpenFileSettings?: () => void;
}

export const RightSidebarPanel: React.FC<RightSidebarPanelProps> = ({
  activeTab,
  onSelectTab,
  budget,
  previewWarning,
  taskGoal,
  onUpdateTaskGoal,
  memoryNotes,
  includedMemoryIds,
  memoryRetrievalEnabled,
  onToggleMemoryRetrieval,
  hoveredSegment,
  onHoverSegment,
  onOpenPromptInspector,
  workspaceFiles,
  allowAiFileEdits,
  onUploadWorkspaceFiles,
  onToggleWorkspaceFileLock,
  onDeleteWorkspaceFile,
  onPreviewWorkspaceFile,
  onOpenFileSettings,
}) => {
  return (
    <aside
      aria-label="Context and local files sidebar"
      className="flex h-full w-[344px] shrink-0 flex-col border-l border-[var(--lc-line)] bg-[var(--lc-panel)] text-[var(--lc-side-ink)]"
    >
      {/* Top Tab Bar */}
      <div className="shrink-0 border-b border-[var(--lc-line)] px-4 pt-3 pb-2.5">
        <div
          role="tablist"
          aria-label="Right sidebar tabs"
          className="grid grid-cols-2 gap-1 rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-1"
        >
          <button
            type="button"
            role="tab"
            data-testid="right-tab-context"
            aria-selected={activeTab === 'context'}
            onClick={() => onSelectTab('context')}
            className={`rounded-[6px] px-2.5 py-1 text-[12.5px] font-semibold transition-colors ${
              activeTab === 'context'
                ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                : 'text-[var(--lc-side-ink2)] hover:text-[var(--lc-side-ink)]'
            }`}
          >
            Context
          </button>
          <button
            type="button"
            role="tab"
            data-testid="right-tab-files"
            aria-selected={activeTab === 'files'}
            onClick={() => onSelectTab('files')}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12.5px] font-semibold transition-colors ${
              activeTab === 'files'
                ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                : 'text-[var(--lc-side-ink2)] hover:text-[var(--lc-side-ink)]'
            }`}
          >
            <span>Files</span>
            {workspaceFiles.length > 0 && (
              <span
                className={`rounded-full px-1.5 py-[1px] text-[10.5px] tabular-nums ${
                  activeTab === 'files'
                    ? 'bg-white/20 text-[var(--lc-active-pill-fg)]'
                    : 'bg-[var(--lc-panel)] text-[var(--lc-side-mute)]'
                }`}
              >
                {workspaceFiles.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {activeTab === 'files' ? (
        <FilesPanel
          files={workspaceFiles}
          allowAiFileEdits={allowAiFileEdits}
          onUploadFiles={onUploadWorkspaceFiles}
          onToggleFileLock={onToggleWorkspaceFileLock}
          onDeleteFile={onDeleteWorkspaceFile}
          onPreviewFile={onPreviewWorkspaceFile}
          onOpenFileSettings={onOpenFileSettings}
        />
      ) : (
        <ContextPanel
          embedded
          budget={budget}
          previewWarning={previewWarning}
          taskGoal={taskGoal}
          onUpdateTaskGoal={onUpdateTaskGoal}
          memoryNotes={memoryNotes}
          includedMemoryIds={includedMemoryIds}
          memoryRetrievalEnabled={memoryRetrievalEnabled}
          onToggleMemoryRetrieval={onToggleMemoryRetrieval}
          hoveredSegment={hoveredSegment}
          onHoverSegment={onHoverSegment}
          onOpenPromptInspector={onOpenPromptInspector}
        />
      )}
    </aside>
  );
};
