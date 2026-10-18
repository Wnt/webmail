import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// The drag-out warm-up downloads a row's whole raw message. It must wait for
// the pointer to rest on the row, and never run for a row that is clicked.

const fetchBlobAsObjectUrl = vi.fn(async () => 'blob:x');
const client = { fetchBlobAsObjectUrl };

vi.mock('@/stores/email-store', () => {
  const state = { selectedEmailKeys: new Set(), emails: [] };
  // The hook reads the selection when a drag starts (getState), not by subscribing.
  return { useEmailStore: Object.assign(() => state, { getState: () => state }) };
});
vi.mock('@/stores/auth-store', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ client }) }));
vi.mock('@/stores/ui-store', () => ({ useUIStore: (sel: (s: unknown) => unknown) => sel({ isMobile: false }) }));
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: (sel: (s: unknown) => unknown) => sel({}) }));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ startDrag: vi.fn(), endDrag: vi.fn(), isDragging: false, draggedEmails: [] }),
}));
vi.mock('@/hooks/use-attachment-drag', () => ({ isDragOutSupported: () => true }));

const { useEmailDrag, HOVER_INTENT_MS } = await import('../use-email-drag');

const email = { id: 'e1', blobId: 'b1', subject: 's', receivedAt: '2026-01-01T00:00:00Z' } as never;

describe('useEmailDrag hover intent', () => {
  beforeEach(() => { vi.useFakeTimers(); fetchBlobAsObjectUrl.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  const handlers = () => renderHook(() => useEmailDrag({ email, sourceMailboxId: 'm' })).result.current.dragHandlers;

  it('does not download for a pointer that only crosses the row', () => {
    const h = handlers();
    act(() => { h.onPointerEnter?.(); vi.advanceTimersByTime(HOVER_INTENT_MS / 2); h.onPointerLeave?.(); vi.advanceTimersByTime(HOVER_INTENT_MS * 2); });
    expect(fetchBlobAsObjectUrl).not.toHaveBeenCalled();
  });

  it('downloads once the pointer rests on the row', () => {
    const h = handlers();
    act(() => { h.onPointerEnter?.(); vi.advanceTimersByTime(HOVER_INTENT_MS - 50); h.onPointerMove?.(); vi.advanceTimersByTime(HOVER_INTENT_MS - 50); });
    expect(fetchBlobAsObjectUrl).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(fetchBlobAsObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('does not download for a row that is clicked', () => {
    const h = handlers();
    act(() => { h.onPointerEnter?.(); vi.advanceTimersByTime(100); h.onPointerDown?.(); vi.advanceTimersByTime(HOVER_INTENT_MS * 4); });
    expect(fetchBlobAsObjectUrl).not.toHaveBeenCalled();
  });

  // A drag event as Chromium delivers it; only what handleDragStart touches.
  const dragEvent = () => ({ dataTransfer: { effectAllowed: '', setData: vi.fn(), setDragImage: vi.fn() } }) as never;

  it('does not download for a hover just under the intent window', () => {
    const h = handlers();
    act(() => { h.onPointerEnter?.(); vi.advanceTimersByTime(HOVER_INTENT_MS - 1); h.onPointerLeave?.(); vi.runAllTimers(); });
    expect(fetchBlobAsObjectUrl).not.toHaveBeenCalled();
  });

  it('a real drag downloads the file, even without a hover', () => {
    expect(HOVER_INTENT_MS).toBe(500);
    const h = handlers();
    act(() => { h.onPointerEnter?.(); vi.advanceTimersByTime(50); h.onPointerDown?.(); h.onDragStart(dragEvent()); });
    expect(fetchBlobAsObjectUrl).toHaveBeenCalledTimes(1);
    expect(fetchBlobAsObjectUrl).toHaveBeenCalledWith('b1', expect.any(String), 'message/rfc822');
  });
});
