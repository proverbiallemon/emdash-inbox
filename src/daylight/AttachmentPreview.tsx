import * as React from "react";
import type { PublicAttachment } from "../lib/attachments";
import { downloadAttachmentBlob, formatAttachmentSize } from "../lib/attachmentClient";
import { Dialog } from "./Dialog";

/** Only passive formats are rendered; never trust a file extension or inject attachment HTML. */
export async function passivePreview(blob: Blob, mime: string): Promise<{ blob?: Blob; text?: string }> {
 const type = mime.toLowerCase().split(";")[0].trim();
 if (type === "text/plain") return { text: await blob.text() };
 const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
 const start = (...signature: number[]) => signature.every((value, i) => bytes[i] === value);
 const valid = (type === "image/png" && start(137,80,78,71,13,10,26,10))
  || (type === "image/jpeg" && start(255,216,255))
  || (type === "image/gif" && start(71,73,70,56) && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97)
  || (type === "image/webp" && start(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80);
 if (!valid) throw new Error("This file cannot be previewed here. Download it to open it in your preferred app.");
 return { blob: new Blob([blob], { type }) };
}

export function AttachmentPreview({ messageId, file, onClose, onDownload, downloading }: {
 messageId: string; file: PublicAttachment; onClose: () => void; onDownload: () => void; downloading: boolean;
}) {
 const [preview, setPreview] = React.useState<{ url?: string; text?: string }>({});
 const [error, setError] = React.useState<string | null>(null);
 React.useEffect(() => {
  let cancelled = false; let url: string | undefined;
  setPreview({}); setError(null);
  void (async () => {
   try {
    if (!["image/png","image/jpeg","image/gif","image/webp","text/plain"].includes(file.mimeType.toLowerCase().split(";")[0].trim())) throw new Error("Preview is available for images and plain text. Download this file to open it.");
    const result = await passivePreview(await downloadAttachmentBlob(messageId, file), file.mimeType);
    if (cancelled) return;
    if (result.blob) url = URL.createObjectURL(result.blob);
    setPreview({ url, text: result.text });
   } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); }
  })();
  return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
 }, [messageId, file]);
 return <Dialog title={file.filename} wide onClose={onClose}>
  <p className="dl-preview-meta">{formatAttachmentSize(file.size)} · {file.mimeType}</p>
  {error ? <p role="status" className="dl-notice">{error}</p> : preview.url ? <img className="dl-preview-image" src={preview.url} alt={file.filename} onError={() => setError("The image could not be displayed. You can still download the original file.")} /> : preview.text !== undefined ? <pre className="dl-preview-text">{preview.text}</pre> : <p role="status">Loading preview…</p>}
  <div className="dl-preview-footer"><button type="button" className="dl-button dl-primary" disabled={downloading} onClick={onDownload}>{downloading ? "Downloading…" : "Download original"}</button></div>
 </Dialog>;
}

