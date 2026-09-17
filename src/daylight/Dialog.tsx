import * as React from "react";

/** Native modal behavior supplies focus containment, Escape and background inertness. */
export function Dialog({ title, onClose, children, wide = false }: {
	title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
	const ref = React.useRef<HTMLDialogElement>(null);
	const label = React.useId();
	React.useEffect(() => {
		const dialog = ref.current!;
		const previous = document.activeElement as HTMLElement | null;
		dialog.showModal();
		return () => { dialog.close(); previous?.focus(); };
	}, []);
	return <dialog ref={ref} className={`dl-dialog ${wide ? "dl-dialog-wide" : ""}`} aria-labelledby={label}
		onCancel={event => { event.preventDefault(); onClose(); }}
		onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
		<div className="dl-dialog-heading"><h2 id={label}>{title}</h2><button type="button" className="dl-icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>
		{children}
	</dialog>;
}
