import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { safeTruncateChars } from '../core/privacy';
import type { NavigationTab, Session } from '../core/types';

interface SidebarNavProps {
  currentTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  sessions: Session[];
  activeSessionId: string;
  generatingSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
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
}) => {
  const navItems: Array<{ id: NavigationTab; label: string; count?: number }> = [
    { id: 'chat', label: 'Chat', count: sessions.length },
    { id: 'models', label: 'Models' },
    { id: 'memory', label: 'Memory' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <aside
      aria-label="Workspace navigation"
      className="flex h-full w-[216px] shrink-0 flex-col border-r border-[#D3D8DF] bg-[#E8EBEF] px-3.5 pt-5 pb-4"
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
          <rect x="1.5" y="1.5" width="23" height="23" rx="5" stroke="#161B26" strokeWidth="2" />
          <line x1="8" y1="2" x2="8" y2="24" stroke="#2A3FE0" strokeWidth="2" />
          <line x1="12" y1="8" x2="21" y2="8" stroke="#161B26" strokeWidth="2" />
          <line x1="12" y1="13" x2="21" y2="13" stroke="#161B26" strokeWidth="2" />
          <line x1="12" y1="18" x2="17" y2="18" stroke="#161B26" strokeWidth="2" />
        </svg>
        <div className="min-w-0">
          <div className="text-[19px] leading-tight font-bold tracking-tight text-[#161B26]">
            LowCon
          </div>
          <div className="text-[11.5px] leading-tight text-[#778091]">
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
              className={`flex h-[34px] w-full items-center justify-between rounded-[6px] px-2.5 text-left text-[14px] ${
                isSelected
                  ? 'bg-[#161B26] font-medium text-white'
                  : 'bg-transparent text-[#444D5C] hover:bg-[#DDE1E7] hover:text-[#161B26]'
              }`}
            >
              <span>{item.label}</span>
              {typeof item.count === 'number' && (
                <span
                  className={`text-[12.5px] ${
                    isSelected ? 'text-[#AEB6C6]' : 'text-[#778091]'
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
        <span className="text-[11px] font-bold tracking-wider text-[#778091]">
          RECENT SESSIONS
        </span>
        <button
          type="button"
          onClick={onNewSession}
          aria-label="Start new chat session"
          title="Start new chat session"
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-[#444D5C] transition-colors hover:bg-[#DDE1E7] hover:text-[#161B26]"
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
                isActive ? 'bg-white' : 'hover:bg-[#DDE1E7]'
              }`}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 bottom-0 left-0 w-[3px] rounded-l-[6px] bg-[#2A3FE0]"
                />
              )}
              <button
                type="button"
                onClick={() => onSelectSession(session.id)}
                className={`flex h-8 flex-1 items-center gap-1.5 truncate pr-2 pl-2.5 text-left text-[13px] ${
                  isActive ? 'font-medium text-[#161B26]' : 'text-[#444D5C]'
                }`}
                title={session.title}
              >
                <span className="truncate">{safeTruncateChars(session.title, 22)}</span>
                {isGeneratingHere && (
                  <span
                    aria-label="Generating response"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#2A3FE0]"
                  />
                )}
              </button>
              {sessions.length > 1 && (
                <button
                  type="button"
                  onClick={() => onDeleteSession(session.id)}
                  aria-label={`Delete session ${session.title}`}
                  title="Delete session"
                  className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-[#778091] hover:bg-[#E8EBEF] hover:text-[#D9383A] group-hover:flex focus:flex"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom Local Boundary Badge */}
      <div className="mt-3 border-t border-[#D3D8DF] pt-2.5">
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#1D7A4E]"
          />
          <span className="text-[12.5px] font-semibold text-[#161B26]">
            Local boundary active
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-[#444D5C]">
          Loopback-only LLM calls. No cloud endpoints, telemetry, or remote tracking.
        </p>
      </div>
    </aside>
  );
};
