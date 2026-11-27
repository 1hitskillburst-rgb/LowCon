export const LEFT_SIDEBAR_MIN = 176;
export const LEFT_SIDEBAR_MAX = 380;
export const LEFT_SIDEBAR_DEFAULT = 216;

export const RIGHT_SIDEBAR_MIN = 260;
export const RIGHT_SIDEBAR_MAX = 560;
export const RIGHT_SIDEBAR_DEFAULT = 344;

export const SIDEBAR_LAYOUT_STORAGE_KEY = 'lowcon_sidebar_layout_v1';

export interface SidebarLayoutState {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
}

export function clampLeftSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return LEFT_SIDEBAR_DEFAULT;
  return Math.max(LEFT_SIDEBAR_MIN, Math.min(LEFT_SIDEBAR_MAX, Math.round(width)));
}

export function clampRightSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_SIDEBAR_DEFAULT;
  return Math.max(RIGHT_SIDEBAR_MIN, Math.min(RIGHT_SIDEBAR_MAX, Math.round(width)));
}

export function createDefaultSidebarLayout(): SidebarLayoutState {
  return {
    leftOpen: true,
    rightOpen: true,
    leftWidth: LEFT_SIDEBAR_DEFAULT,
    rightWidth: RIGHT_SIDEBAR_DEFAULT,
  };
}

export function loadSidebarLayoutState(): SidebarLayoutState {
  const defaults = createDefaultSidebarLayout();
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<SidebarLayoutState>;
    return {
      leftOpen: typeof parsed.leftOpen === 'boolean' ? parsed.leftOpen : defaults.leftOpen,
      rightOpen: typeof parsed.rightOpen === 'boolean' ? parsed.rightOpen : defaults.rightOpen,
      leftWidth:
        typeof parsed.leftWidth === 'number'
          ? clampLeftSidebarWidth(parsed.leftWidth)
          : defaults.leftWidth,
      rightWidth:
        typeof parsed.rightWidth === 'number'
          ? clampRightSidebarWidth(parsed.rightWidth)
          : defaults.rightWidth,
    };
  } catch {
    return defaults;
  }
}

export function saveSidebarLayoutState(state: SidebarLayoutState): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      SIDEBAR_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        leftOpen: state.leftOpen,
        rightOpen: state.rightOpen,
        leftWidth: clampLeftSidebarWidth(state.leftWidth),
        rightWidth: clampRightSidebarWidth(state.rightWidth),
      }),
    );
  } catch {
    // Ignore storage quota errors for non-sensitive UI geometry
  }
}
