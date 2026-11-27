import React, { useEffect, useRef, useState } from 'react';

interface SplitPaneIconProps {
  open: boolean;
  className?: string;
}

/**
 * Matches the split-panel toggle icons from the reference layout:
 * rounded frame split vertically, with the active pane filled when open
 * and crisp outline divider when closed.
 */
export const LeftSidebarIcon: React.FC<SplitPaneIconProps> = ({ open, className = 'h-[17px] w-[17px]' }) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    className={className}
  >
    <rect
      x="2"
      y="3.2"
      width="16"
      height="13.6"
      rx="2.6"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    {open ? (
      <path
        d="M4.6 3.2H8.5V16.8H4.6C3.16406 16.8 2 15.6359 2 14.2V5.8C2 4.36406 3.16406 3.2 4.6 3.2Z"
        fill="currentColor"
      />
    ) : (
      <line x1="8" y1="3.8" x2="8" y2="16.2" stroke="currentColor" strokeWidth="1.5" />
    )}
  </svg>
);

export const RightSidebarIcon: React.FC<SplitPaneIconProps> = ({
  open,
  className = 'h-[17px] w-[17px]',
}) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    className={className}
  >
    <rect
      x="2"
      y="3.2"
      width="16"
      height="13.6"
      rx="2.6"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    {open ? (
      <path
        d="M11.5 3.2H15.4C16.8359 3.2 18 4.36406 18 5.8V14.2C18 15.6359 16.8359 16.8 15.4 16.8H11.5V3.2Z"
        fill="currentColor"
      />
    ) : (
      <line x1="12" y1="3.8" x2="12" y2="16.2" stroke="currentColor" strokeWidth="1.5" />
    )}
  </svg>
);

export const LeftSidebarToggleButton: React.FC<{
  open: boolean;
  onToggle: () => void;
}> = ({ open, onToggle }) => (
  <button
    type="button"
    data-testid="toggle-left-sidebar"
    onClick={onToggle}
    aria-label={open ? 'Hide left sidebar' : 'Show left sidebar'}
    aria-pressed={open}
    title={open ? 'Hide left sidebar' : 'Show left sidebar'}
    className={`flex h-7 w-7 items-center justify-center rounded-[6px] border transition-colors ${
      open
        ? 'border-[var(--lc-line)] bg-[var(--lc-panel)]/70 text-[var(--lc-ink)] hover:bg-[var(--lc-hover)]'
        : 'border-transparent text-[var(--lc-mute)] hover:border-[var(--lc-line)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]'
    }`}
  >
    <LeftSidebarIcon open={open} />
  </button>
);

export const RightSidebarToggleButton: React.FC<{
  open: boolean;
  onToggle: () => void;
}> = ({ open, onToggle }) => (
  <button
    type="button"
    data-testid="toggle-right-sidebar"
    onClick={onToggle}
    aria-label={open ? 'Hide right sidebar' : 'Show right sidebar'}
    aria-pressed={open}
    title={open ? 'Hide right sidebar' : 'Show right sidebar'}
    className={`flex h-7 w-7 items-center justify-center rounded-[6px] border transition-colors ${
      open
        ? 'border-[var(--lc-line)] bg-[var(--lc-panel)]/70 text-[var(--lc-ink)] hover:bg-[var(--lc-hover)]'
        : 'border-transparent text-[var(--lc-mute)] hover:border-[var(--lc-line)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]'
    }`}
  >
    <RightSidebarIcon open={open} />
  </button>
);

interface SidebarResizeHandleProps {
  side: 'left' | 'right';
  width: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  onResize: (nextWidth: number) => void;
}

export const SidebarResizeHandle: React.FC<SidebarResizeHandleProps> = ({
  side,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  onResize,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setIsDragging(true);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = side === 'left' ? startWidth + delta : startWidth - delta;
      onResize(next);
    };

    const cleanup = () => {
      setIsDragging(false);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      cleanupRef.current = null;
    };

    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onResize(side === 'left' ? width - 16 : width + 16);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onResize(side === 'left' ? width + 16 : width - 16);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onResize(defaultWidth);
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize left sidebar' : 'Resize right sidebar'}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      data-testid={`${side}-sidebar-resizer`}
      title="Drag to resize sidebar (double-click to reset)"
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={handleKeyDown}
      className={`group/resizer absolute top-0 bottom-0 z-20 w-[7px] cursor-col-resize select-none focus:outline-none ${
        side === 'left' ? '-right-[3px]' : '-left-[3px]'
      }`}
    >
      <div
        className={`mx-auto h-full w-[2px] transition-colors ${
          isDragging
            ? 'bg-[var(--lc-accent)]'
            : 'bg-transparent group-hover/resizer:bg-[var(--lc-accent)]/55 group-focus-visible/resizer:bg-[var(--lc-accent)]'
        }`}
      />
    </div>
  );
};
