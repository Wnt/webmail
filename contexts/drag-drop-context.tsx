"use client";

import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from "react";
import { Email } from "@/lib/jmap/types";

interface DragDropState {
  isDragging: boolean;
  draggedEmails: Email[];
  dragCount: number;
  sourceMailboxId: string | null;
}

interface DragDropContextValue extends DragDropState {
  startDrag: (emails: Email[], sourceMailboxId: string) => void;
  endDrag: () => void;
}

const initialState: DragDropState = {
  isDragging: false,
  draggedEmails: [],
  dragCount: 0,
  sourceMailboxId: null,
};

const DragDropContext = createContext<DragDropContextValue | null>(null);

export function DragDropProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DragDropState>(initialState);

  const startDrag = useCallback((emails: Email[], sourceMailboxId: string) => {
    setState({
      isDragging: true,
      draggedEmails: emails,
      dragCount: emails.length,
      sourceMailboxId,
    });
  }, []);

  const endDrag = useCallback(() => {
    setState(initialState);
  }, []);

  // Fork (Wnt/webmail): one value per drag state. The provider wraps the
  // whole mail app and re-renders with it; a fresh object each time
  // re-rendered every drag consumer - every list row and folder row - on
  // every store write, memoised or not.
  const value = useMemo(() => ({ ...state, startDrag, endDrag }), [state, startDrag, endDrag]);
  return (
    <DragDropContext.Provider value={value}>
      {children}
    </DragDropContext.Provider>
  );
}

export function useDragDropContext() {
  const context = useContext(DragDropContext);
  if (!context) {
    throw new Error("useDragDropContext must be used within DragDropProvider");
  }
  return context;
}
