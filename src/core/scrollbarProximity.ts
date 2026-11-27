export const SCROLL_PROXIMITY_PX = 36;

export interface ScrollEdgeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Returns true when the pointer is within `proximityPx` of a scrollable element's
 * vertical (right) or horizontal (bottom) scrollbar edge.
 */
export function isNearScrollbarEdge(
  rect: ScrollEdgeRect,
  clientX: number,
  clientY: number,
  hasVertical: boolean,
  hasHorizontal: boolean,
  proximityPx = SCROLL_PROXIMITY_PX,
): boolean {
  if (
    hasVertical &&
    clientX >= rect.right - proximityPx &&
    clientX <= rect.right + 4 &&
    clientY >= rect.top - 4 &&
    clientY <= rect.bottom + 4
  ) {
    return true;
  }
  if (
    hasHorizontal &&
    clientY >= rect.bottom - proximityPx &&
    clientY <= rect.bottom + 4 &&
    clientX >= rect.left - 4 &&
    clientX <= rect.right + 4
  ) {
    return true;
  }
  return false;
}

const NEAR_CLASS = 'lc-scroll-near';

function isScrollableOverflow(val: string): boolean {
  return val === 'auto' || val === 'scroll' || val === 'overlay';
}

/**
 * Reveals scrollbars smoothly only when the mouse moves close to a scrollable
 * container's scrollbar edge or while actively scrolling.
 */
export function initScrollbarProximity(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {};
  }

  const pointerNearSet = new Set<HTMLElement>();
  const scrollActiveTimers = new Map<HTMLElement, number>();
  let rafId: number | null = null;
  let lastPointerEvent: { clientX: number; clientY: number; target: EventTarget | null } | null = null;

  const syncClass = (el: HTMLElement) => {
    if (pointerNearSet.has(el) || scrollActiveTimers.has(el)) {
      el.classList.add(NEAR_CLASS);
    } else {
      el.classList.remove(NEAR_CLASS);
    }
  };

  const evaluatePointer = () => {
    rafId = null;
    const evt = lastPointerEvent;
    if (!evt) return;

    const nextNear = new Set<HTMLElement>();
    let cursor = evt.target instanceof HTMLElement ? evt.target : null;

    while (cursor) {
      const hasVertical = cursor.scrollHeight > cursor.clientHeight + 1;
      const hasHorizontal = cursor.scrollWidth > cursor.clientWidth + 1;
      if (hasVertical || hasHorizontal) {
        const style = window.getComputedStyle(cursor);
        const vScrollable = hasVertical && isScrollableOverflow(style.overflowY);
        const hScrollable = hasHorizontal && isScrollableOverflow(style.overflowX);
        if (vScrollable || hScrollable) {
          const rect = cursor.getBoundingClientRect();
          if (isNearScrollbarEdge(rect, evt.clientX, evt.clientY, vScrollable, hScrollable)) {
            nextNear.add(cursor);
          }
        }
      }
      cursor = cursor.parentElement;
    }

    for (const prev of pointerNearSet) {
      if (!nextNear.has(prev)) {
        pointerNearSet.delete(prev);
        syncClass(prev);
      }
    }
    for (const next of nextNear) {
      if (!pointerNearSet.has(next)) {
        pointerNearSet.add(next);
        syncClass(next);
      }
    }
  };

  const handlePointerMove = (e: PointerEvent) => {
    lastPointerEvent = { clientX: e.clientX, clientY: e.clientY, target: e.target };
    if (rafId === null) {
      rafId = window.requestAnimationFrame(evaluatePointer);
    }
  };

  const clearPointerNear = () => {
    lastPointerEvent = null;
    for (const el of pointerNearSet) {
      pointerNearSet.delete(el);
      syncClass(el);
    }
  };

  const handleScroll = (e: Event) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      target.scrollHeight <= target.clientHeight + 1 &&
      target.scrollWidth <= target.clientWidth + 1
    ) {
      return;
    }
    const existingTimer = scrollActiveTimers.get(target);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    const timer = window.setTimeout(() => {
      scrollActiveTimers.delete(target);
      syncClass(target);
    }, 850);
    scrollActiveTimers.set(target, timer);
    syncClass(target);
  };

  document.addEventListener('pointermove', handlePointerMove, { passive: true });
  document.addEventListener('pointerleave', clearPointerNear, { passive: true });
  window.addEventListener('blur', clearPointerNear);
  document.addEventListener('scroll', handleScroll, { capture: true, passive: true });

  return () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
    }
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerleave', clearPointerNear);
    window.removeEventListener('blur', clearPointerNear);
    document.removeEventListener('scroll', handleScroll, { capture: true });
    for (const [el, timer] of scrollActiveTimers) {
      window.clearTimeout(timer);
      el.classList.remove(NEAR_CLASS);
    }
    scrollActiveTimers.clear();
    clearPointerNear();
  };
}
