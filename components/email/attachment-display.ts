import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo } from "@/components/icons";
import { stripBidiControls } from "@/lib/bidi";

// Helper function to get file icon based on mime type or extension
export const getFileIcon = (name?: string, type?: string) => {
  const ext = name?.split('.').pop()?.toLowerCase();
  const mimeType = type?.toLowerCase();

  if (mimeType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext || '')) {
    return FileImage;
  }
  if (mimeType?.startsWith('video/') || ['mp4', 'avi', 'mov', 'wmv'].includes(ext || '')) {
    return FileVideo;
  }
  if (mimeType?.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac'].includes(ext || '')) {
    return FileAudio;
  }
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return FileText;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || '')) {
    return FileArchive;
  }
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext || '')) {
    return FileText;
  }
  return File;
};

const MIME_TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'Document.pdf',
  'application/zip': 'Archive.zip',
  'application/x-zip-compressed': 'Archive.zip',
  'application/gzip': 'Archive.gz',
  'application/x-rar-compressed': 'Archive.rar',
  'application/x-7z-compressed': 'Archive.7z',
  'application/msword': 'Document.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document.docx',
  'application/vnd.ms-excel': 'Spreadsheet.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet.xlsx',
  'application/vnd.ms-powerpoint': 'Presentation.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Presentation.pptx',
  'text/plain': 'Text.txt',
  'text/html': 'Document.html',
  'text/csv': 'Data.csv',
  'application/json': 'Data.json',
  'application/xml': 'Data.xml',
  'application/octet-stream': 'Attachment',
  'message/rfc822': 'Email.eml',
};

export const getAttachmentDisplayName = (name: string | null | undefined, mimeType?: string): string => {
  // Without directional overrides, which would show `report\u202Efdp.exe`
  // as `reportexe.pdf` (upstream 29b33eb4; the download name is cleaned separately).
  if (name) return stripBidiControls(name);
  if (mimeType) {
    const label = MIME_TYPE_LABELS[mimeType.toLowerCase()];
    if (label) return label;
    const sub = mimeType.split('/')[1];
    if (sub) {
      const clean = sub.replace(/^x-/, '').replace(/^vnd\./, '');
      return `Attachment.${clean}`;
    }
  }
  return 'Attachment';
};
