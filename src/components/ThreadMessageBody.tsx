import * as React from "react";
import { sanitizeEmailHtml } from "../lib/sanitize";

interface Props {
	bodyHtml: string | null;
	bodyText: string;
	showImages: boolean;
	onRevealImages: () => void;
}

/**
 * Detect whether the raw HTML body has any external <img src>. Used to decide
 * whether to show the "images hidden" banner. A cheap string check is enough
 * here — a false positive just means the banner shows when there's nothing
 * to reveal, which is harmless.
 */
function hasExternalImages(html: string): boolean {
	return /<img[^>]+src\s*=\s*["']?https?:/i.test(html);
}

export function ThreadMessageBody({ bodyHtml, bodyText, showImages, onRevealImages }: Props) {
	if (bodyHtml) {
		const imagesHidden = !showImages && hasExternalImages(bodyHtml);
		const sanitized = sanitizeEmailHtml(bodyHtml, { allowExternalImages: showImages });

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
