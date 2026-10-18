// Fork (Wnt/webmail): what "the whole message" is for the reading pane - the
// Email/get properties and body options of JMAPClient.getEmail. Shared with
// the push preview route, which can hand the service worker the same object
// to keep for the notification's tap (lib/push-prefetch.ts), so both must ask
// for exactly the same thing.
export const FULL_EMAIL_PROPERTIES = [
  "id", "threadId", "mailboxIds", "keywords", "size",
  "receivedAt", "sentAt", "from", "to", "cc", "bcc", "replyTo",
  "subject", "preview", "textBody", "htmlBody", "bodyValues",
  "hasAttachment", "attachments", "messageId", "inReplyTo",
  "references", "headers", "bodyStructure", "blobId",
] as const;

export const FULL_EMAIL_BODY_OPTIONS = {
  fetchTextBodyValues: true,
  fetchHTMLBodyValues: true,
  fetchAllBodyValues: true,
  maxBodyValueBytes: 256000,
} as const;
