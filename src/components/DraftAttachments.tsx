import * as React from "react";
import type { PublicAttachment } from "../lib/attachments";
import { formatAttachmentSize } from "../lib/attachmentClient";

interface Props {
	attachments: PublicAttachment[];
	disabled: boolean;
	uploading: boolean;
	onUpload: (files: File[]) => void;
	onRemove: (id: string) => void;
}

export function DraftAttachments({ attachments, disabled, uploading, onUpload, onRemove }: Props) {
	const inputId = React.useId();
	return <div className="space-y-2">
		{attachments.length > 0 && <ul className="flex flex-wrap gap-2" aria-label="Attached files">
			{attachments.map((file) => <li key={file.id} className="flex max-w-full items-center gap-2 rounded border px-2 py-1 text-xs">
				<span className="truncate">{file.filename}</span><span className="whitespace-nowrap text-muted-foreground">{formatAttachmentSize(file.size)}</span>
				<button type="button" disabled={disabled} aria-label={`Remove ${file.filename}`} className="text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => onRemove(file.id)}>×</button>
			</li>)}
		</ul>}
		<div className="flex flex-wrap items-center gap-2 text-xs">
			<label htmlFor={inputId} className="font-medium">Attach files</label>
			<input id={inputId} type="file" multiple disabled={disabled} className="max-w-full text-xs disabled:opacity-50" onChange={(event) => {
				const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
				if (files.length) onUpload(files);
			}} />
			<span className="text-muted-foreground">Up to 3 MiB total</span>
		</div>
		{uploading && <p role="status" className="text-xs text-muted-foreground">Uploading files…</p>}
	</div>;
}
