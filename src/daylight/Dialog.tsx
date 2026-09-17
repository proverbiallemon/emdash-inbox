import * as React from "react";

/** Native modal behavior supplies focus containment, Escape and background inertness. */
export function Dialog({ title, onClose, children, wide = false, descriptionId, initialFocus }: {
	title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; descriptionId?: string;
	initialFocus?: React.RefObject<HTMLElement | null>;
}) {
	const ref = React.useRef<HTMLDialogElement>(null);
	const label = React.useId();
	React.useEffect(() => {
		const dialog = ref.current!;
		const previous = document.activeElement as HTMLElement | null;
		dialog.showModal();
		initialFocus?.current?.focus();
		return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
	}, []);
	return <dialog ref={ref} className={`dl-dialog ${wide ? "dl-dialog-wide" : ""}`} aria-labelledby={label} aria-describedby={descriptionId}
		onCancel={event => { event.preventDefault(); onClose(); }}
		onKeyDown={event => {
			if (event.key !== "Tab") return;
			const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
				.filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
			const next = event.shiftKey ? targets.at(-1) : targets[0];
			const edge = event.shiftKey ? targets[0] : targets.at(-1);
			if (next && (document.activeElement === edge || document.activeElement === event.currentTarget)) {
				event.preventDefault(); next.focus();
			}
		}}
		onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
		<div className="dl-dialog-heading"><h2 id={label}>{title}</h2><button type="button" className="dl-icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>
		{children}
	</dialog>;
}
