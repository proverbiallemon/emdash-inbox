import * as React from "react";
import { Icon } from "../daylight/Icon";
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
	return <div className="dl-draft-attachments">
		{attachments.length > 0 && <ul className="dl-draft-files" aria-label="Attached files">
			{attachments.map((file) => <li key={file.id} className="dl-file">
				<Icon name="attachment" /><span className="dl-file-copy"><strong>{file.filename}</strong><small>{formatAttachmentSize(file.size)}</small></span>
				<button type="button" disabled={disabled} aria-label={`Remove ${file.filename}`} className="dl-icon-button" onClick={() => onRemove(file.id)}>×</button>
			</li>)}
		</ul>}
		<div className="dl-attach-control">
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
