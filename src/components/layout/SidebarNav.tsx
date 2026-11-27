import React from 'react';
import { Plus, Trash2, User } from 'lucide-react';
import { safeTruncateChars } from '../../core/privacy';
import { formatCompactTokens } from '../../core/tokenUsage';
import type { NavigationTab, Session } from '../../core/types';

interface SidebarNavProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  sessions: Session[];
  activeSessionId: string;
  generatingSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  username?: string;
  totalLifetimeTokens?: number;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
  currentTab,
  onSelectTab,
  sessions,
  activeSessionId,
  generatingSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  username,
  totalLifetimeTokens = 0,
}) => {
  const navItems: Array<{ id: NavigationTab; label: string; count?: number }> = [
    { id: 'chat', label: 'Chat', count: sessions.length },
    { id: 'models', label: 'Models' },
    { id: 'memory', label: 'Memory' },
    { id: 'settings', label: 'Settings' },
  ];

  const trimmedUsername = username?.trim() ?? '';
  const displayName = trimmedUsername || 'Profile';
  const displayInitial = trimmedUsername ? Array.from(trimmedUsername)[0].toUpperCase() : null;
  const isProfileActive = currentTab === 'profile';

  return (
    <aside
      aria-label="Workspace navigation"
      className="flex h-full w-[216px] shrink-0 flex-col border-r border-[var(--lc-line)] bg-[var(--lc-side)] px-3.5 pt-5 pb-4 text-[var(--lc-side-ink)]"
    >
      {/* Brand Header matching src/ui/nav.rs */}
      <div className="flex items-center gap-2.5">
        <svg
          width="26"
          height="26"
          viewBox="0 0 26 26"
          fill="none"
          aria-hidden="true"
          className="shrink-0"
        >
          <rect x="1.5" y="1.5" width="23" height="23" rx="5" stroke="var(--lc-side-ink)" strokeWidth="2" />
          <line x1="8" y1="2" x2="8" y2="24" stroke="var(--lc-accent)" strokeWidth="2" />
          <line x1="12" y1="8" x2="21" y2="8" stroke="var(--lc-side-ink)" strokeWidth="2" />
          <line x1="12" y1="13" x2="21" y2="13" stroke="var(--lc-side-ink)" strokeWidth="2" />
          <line x1="12" y1="18" x2="17" y2="18" stroke="var(--lc-side-ink)" strokeWidth="2" />
        </svg>
        <div className="min-w-0">
          <div className="text-[19px] leading-tight font-bold tracking-tight text-[var(--lc-side-ink)]">
            LowCon
          </div>
          <div className="text-[11.5px] leading-tight text-[var(--lc-side-mute)]">
            Local model workbench
          </div>
        </div>
      </div>

      {/* Primary Navigation Tabs */}
      <nav aria-label="Main sections" className="mt-5 flex flex-col gap-1">
        {navItems.map((item) => {
          const isSelected = currentTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isSelected ? 'page' : undefined}
              className={`flex h-[34px] w-full items-center justify-between rounded-[6px] border px-2.5 text-left text-[14px] transition-colors ${
                isSelected
                  ? 'border-[var(--lc-active-pill-bg)] bg-transparent font-semibold text-[var(--lc-side-ink)]'
                  : 'border-transparent bg-transparent text-[var(--lc-side-ink2)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-side-ink)]'
              }`}
            >
              <span>{item.label}</span>
              {typeof item.count === 'number' && (
                <span
                  className={`text-[12.5px] ${
                    isSelected ? 'text-[var(--lc-side-ink2)]' : 'text-[var(--lc-side-mute)]'
                  }`}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Recent Sessions Section */}
      <div className="mt-6 flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wider text-[var(--lc-side-mute)]">
          RECENT SESSIONS
        </span>
        <button
          type="button"
          onClick={onNewSession}
          aria-label="Start new chat session"
          title="Start new chat session"
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-[var(--lc-side-ink2)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-side-ink)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId && currentTab === 'chat';
          const isGeneratingHere = generatingSessionId === session.id;
          return (
            <div
              key={session.id}
              className={`group relative flex items-center rounded-[6px] transition-colors ${
                isActive ? 'bg-[var(--lc-surface)]' : 'hover:bg-[var(--lc-hover)]'
              }`}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 bottom-0 left-0 w-[3px] rounded-l-[6px] bg-[var(--lc-accent)]"
                />
              )}
              <button
                type="button"
                onClick={() => onSelectSession(session.id)}
                className={`flex h-8 flex-1 items-center gap-1.5 truncate pr-2 pl-2.5 text-left text-[13px] ${
                  isActive ? 'font-medium text-[var(--lc-surf-ink)]' : 'text-[var(--lc-side-ink2)]'
                }`}
                title={session.title}
              >
                <span className="truncate">{safeTruncateChars(session.title, 22)}</span>
                {isGeneratingHere && (
                  <span
                    aria-label="Generating response"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lc-accent)]"
                  />
                )}
              </button>
              {sessions.length > 1 && (
                <button
                  type="button"
                  onClick={() => onDeleteSession(session.id)}
                  aria-label={`Delete session ${session.title}`}
                  title="Delete session"
                  className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--lc-side-mute)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-danger)] group-hover:flex focus:flex"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom Profile Entry */}
      <div className="mt-3 border-t border-[var(--lc-line)] pt-2.5">
        <button
          type="button"
          data-testid="sidebar-profile-button"
          onClick={() => onSelectTab('profile')}
          aria-current={isProfileActive ? 'page' : undefined}
          className={`flex w-full items-center gap-2.5 rounded-[7px] border px-2 py-1.5 text-left transition-colors ${
            isProfileActive
              ? 'border-[var(--lc-active-pill-bg)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)]'
              : 'border-transparent bg-transparent text-[var(--lc-side-ink)] hover:bg-[var(--lc-hover)]'
          }`}
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--lc-accent)] text-[12px] font-bold text-[var(--lc-accent-contrast)]"
          >
            {displayInitial ?? <User className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className={`truncate text-[13px] leading-tight font-semibold ${
                isProfileActive ? 'text-[var(--lc-surf-ink)]' : 'text-[var(--lc-side-ink)]'
              }`}
            >
              {displayName}
            </div>
            <div
              className={`truncate text-[11px] leading-tight tabular-nums ${
                isProfileActive ? 'text-[var(--lc-surf-mute)]' : 'text-[var(--lc-side-mute)]'
              }`}
            >
              {formatCompactTokens(totalLifetimeTokens)} tokens lifetime
            </div>
          </div>
        </button>
      </div>
    </aside>
  );
};
