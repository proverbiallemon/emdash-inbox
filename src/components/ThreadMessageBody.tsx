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
			<div className="dl-message-html">
				{imagesHidden && (
					<div className="dl-image-notice">
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
		<div className="dl-message-html"><pre>{bodyText}</pre></div>
	);
}
