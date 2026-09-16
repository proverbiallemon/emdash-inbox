import * as React from "react";
import type { PublicAttachment } from "../lib/attachments";
import { formatAttachmentSize, saveAttachmentDownload } from "../lib/attachmentClient";

export function AttachmentDownloads({ messageId, attachments }: { messageId: string; attachments: PublicAttachment[] }) {
	const [downloading, setDownloading] = React.useState<string | null>(null);
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
	return <div className="mt-3 space-y-2">
		<ul className="flex flex-wrap gap-2" aria-label="Attachments">
			{attachments.map((file) => <li key={file.id}>
				<button type="button" disabled={downloading !== null} onClick={() => void download(file)} className="flex max-w-full items-center gap-2 rounded border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
					<span className="truncate">{downloading === file.id ? "Downloading…" : file.filename}</span><span className="whitespace-nowrap text-xs text-muted-foreground">{formatAttachmentSize(file.size)}</span>
				</button>
			</li>)}
		</ul>
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
	</div>;
}
