import * as React from "react";
import { prepareEmailHtml } from "../lib/sanitize";

interface Props {
	bodyHtml: string | null;
	bodyText: string;
	showImages: boolean;
	onRevealImages: () => void;
}

export function ThreadMessageBody({ bodyHtml, bodyText, showImages, onRevealImages }: Props) {
	if (bodyHtml) {
		const { html: sanitized, hasExternalImages } = prepareEmailHtml(bodyHtml, {
			allowExternalImages: showImages,
		});
		const imagesHidden = !showImages && hasExternalImages;

		return (
			<div className="prose prose-sm max-w-none">
				{imagesHidden && (
					<div className="mb-2 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
						<span>External images hidden.</span>
						<button
							type="button"
							className="text-xs underline hover:no-underline"
							onClick={onRevealImages}
						>
							Show images
						</button>
					</div>
				)}
				<div dangerouslySetInnerHTML={{ __html: sanitized }} />
			</div>
		);
	}

	return (
		<pre className="text-sm whitespace-pre-wrap font-sans">{bodyText}</pre>
	);
}
