// Fork (Wnt/webmail): which parts the reading pane and the conversation cards
// fetch when a message opens, so that its `cid:` references can show.

import { isTnefAttachment } from '@/lib/tnef';

interface PartLike {
  cid?: string | null;
  blobId?: string | null;
  name?: string | null;
  type?: string | null;
}

/** A winmail.dat or an embedded message (by type or, for TNEF, by name). */
export function isWrappedMessagePart(att: Pick<PartLike, 'name' | 'type'>): boolean {
  return (att.type || '').toLowerCase() === 'message/rfc822' || isTnefAttachment(att.name, att.type ?? undefined);
}

/**
 * A part with a Content-ID and a blob, unless it is a winmail.dat or an
 * embedded message: neither is ever an inline picture, and opening a message
 * must not download such a part by itself (upstream bf64f4d4 leaves big ones
 * as attachment chips; a sender-added Content-ID must not undo that). Such a
 * part also always keeps its chip (lib/attachment-visibility.ts).
 */
export function isInlineCidPart(att: PartLike): boolean {
  return !!att.cid && !!att.blobId && !isWrappedMessagePart(att);
}
