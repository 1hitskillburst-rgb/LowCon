import React from 'react';
import {
  RIGHT_SIDEBAR_DEFAULT,
  RIGHT_SIDEBAR_MAX,
  RIGHT_SIDEBAR_MIN,
} from '../../core/sidebarLayout';
import type {
  ContextSegmentKey,
  MemoryNote,
  TurnContextBudget,
  WorkspaceFile,
} from '../../core/types';
import { SidebarResizeHandle } from '../layout/SidebarToggleIcons';
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
  width?: number;
  onResizeWidth?: (width: number) => void;
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
  width = RIGHT_SIDEBAR_DEFAULT,
  onResizeWidth,
}) => {
  return (
    <aside
      aria-label="Context and local files sidebar"
      style={{ width: `${width}px` }}
      className="relative flex h-full shrink-0 flex-col border-l border-[var(--lc-panel-line)] bg-[var(--lc-panel)] text-[var(--lc-panel-ink)]"
    >
      {/* Top Tab Bar */}
      <div className="shrink-0 border-b border-[var(--lc-panel-line)] px-4 pt-3 pb-2.5">
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
                ? 'bg-[var(--lc-surf-active-bg)] text-[var(--lc-surf-active-fg)]'
                : 'text-[var(--lc-surf-ink2)] hover:text-[var(--lc-surf-ink)]'
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
                ? 'bg-[var(--lc-surf-active-bg)] text-[var(--lc-surf-active-fg)]'
                : 'text-[var(--lc-surf-ink2)] hover:text-[var(--lc-surf-ink)]'
            }`}
          >
            <span>Files</span>
            {workspaceFiles.length > 0 && (
              <span
                className={`rounded-full px-1.5 py-[1px] text-[10.5px] tabular-nums ${
                  activeTab === 'files'
                    ? 'bg-[var(--lc-surf-active-badge-bg)] text-[var(--lc-surf-active-fg)]'
                    : 'bg-[var(--lc-surf-hover)] text-[var(--lc-surf-ink2)]'
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

      {onResizeWidth && (
        <SidebarResizeHandle
          side="right"
          width={width}
          minWidth={RIGHT_SIDEBAR_MIN}
          maxWidth={RIGHT_SIDEBAR_MAX}
          defaultWidth={RIGHT_SIDEBAR_DEFAULT}
          onResize={onResizeWidth}
        />
      )}
    </aside>
  );
};
