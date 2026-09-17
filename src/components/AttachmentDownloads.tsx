import * as React from "react";
import type { PublicAttachment } from "../lib/attachments";
import { formatAttachmentSize, saveAttachmentDownload } from "../lib/attachmentClient";
import { AttachmentPreview } from "../daylight/AttachmentPreview";
import { Icon } from "../daylight/Icon";

export function AttachmentDownloads({ messageId, attachments }: { messageId: string; attachments: PublicAttachment[] }) {
 const [downloading, setDownloading] = React.useState<string | null>(null);
 const [preview, setPreview] = React.useState<PublicAttachment | null>(null);
 const [error, setError] = React.useState<string | null>(null);
 const locked = React.useRef(false);
 if (!attachments.length) return null;
 const download = async (file: PublicAttachment) => {
  if (locked.current) return;
  locked.current = true; setDownloading(file.id); setError(null);
  try { await saveAttachmentDownload(messageId, file); }
  catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  finally { locked.current = false; setDownloading(null); }
 };
 return <div className="dl-attachments">
  <ul aria-label="Attachments">
   {attachments.map(file => <li key={file.id}>
    <button type="button" className="dl-file" onClick={() => setPreview(file)} aria-label={`Preview ${file.filename}`}>
     <Icon name="attachment" /><span className="dl-file-copy"><strong>{file.filename}</strong><small>{formatAttachmentSize(file.size)} · Preview file</small></span>
    </button>
    <button type="button" className="dl-file-download" disabled={downloading !== null} onClick={() => void download(file)} aria-label={`Download ${file.filename}`}>{downloading === file.id ? "Downloading…" : "Download"}</button>
   </li>)}
  </ul>
  {error && <p role="alert">{error}</p>}
  {preview && <AttachmentPreview messageId={messageId} file={preview} onClose={() => setPreview(null)} onDownload={() => void download(preview)} downloading={downloading !== null} />}
 </div>;
}
