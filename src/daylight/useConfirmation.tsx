import * as React from "react";
import { Dialog } from "./Dialog";

interface Confirmation { title: string; description: string; action: string }

/** One pending choice per editor. Unmounting cancels any suspended action. */
export function useConfirmation() {
	const [choice, setChoice] = React.useState<Confirmation | null>(null);
	const cancelButton = React.useRef<HTMLButtonElement>(null);
	const pending = React.useRef<((accepted: boolean) => void) | null>(null);
	const confirm = React.useCallback((next: Confirmation): Promise<boolean> => {
		if (pending.current) return Promise.resolve(false);
		return new Promise(resolve => { pending.current = resolve; setChoice(next); });
	}, []);
	const finish = (accepted: boolean) => {
		const resolve = pending.current;
		pending.current = null;
		setChoice(null);
		resolve?.(accepted);
	};
	React.useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
	const descriptionId = React.useId();
	return {
		confirm, pending,
		dialog: choice && <Dialog title={choice.title} descriptionId={descriptionId} initialFocus={cancelButton} onClose={() => finish(false)}>
			<p id={descriptionId} className="dl-muted">{choice.description}</p>
			<div className="dl-confirm-actions">
				<button type="button" className="dl-button" ref={cancelButton} onClick={() => finish(false)}>Keep editing</button>
				<button type="button" className="dl-button dl-destructive" onClick={() => finish(true)}>{choice.action}</button>
			</div>
		</Dialog>,
	};
}

export const leaveConfirmation = {
	title: "Leave without saving?",
	description: "Your latest changes will be lost. Any previously saved draft will stay in Drafts.",
	action: "Leave without saving",
};
