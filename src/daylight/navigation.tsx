import * as React from "react";

interface LeaveGuard { canLeave: () => boolean | Promise<boolean>; canReplace?: () => boolean | Promise<boolean>; hasUnsaved: () => boolean }
const NavigationContext = React.createContext<{
	register: (guard: LeaveGuard) => () => void;
	allow: () => Promise<boolean>;
	replace: () => Promise<boolean>;
}>({ register: () => () => {}, allow: async () => true, replace: async () => true });

export function NavigationProvider({ children }: { children: React.ReactNode }) {
	const guard = React.useRef<LeaveGuard | null>(null);
	const pending = React.useRef(false);
	const replaying = React.useRef<HTMLAnchorElement | null>(null);
	const approvedUnload = React.useRef(false);
	const request = React.useCallback(async (replace = false) => {
		if (pending.current) return false;
		const current = guard.current;
		if (!current) return true;
		pending.current = true;
		try {
			const accepted = await (replace ? current.canReplace ?? current.canLeave : current.canLeave)();
			return accepted && guard.current === current;
		} finally { pending.current = false; }
	}, []);
	const value = React.useMemo(() => ({
		register(next: LeaveGuard) { guard.current = next; return () => { if (guard.current === next) guard.current = null; }; },
		allow: () => request(),
		replace: () => request(true),
	}), [request]);
	React.useEffect(() => {
		// EmDash's sidebar lives outside the plugin's React/portal tree. Capture
		// page links before the host router can unmount an unsaved mail editor.
		const beforeLink = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
			if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
			if (link === replaying.current || !guard.current?.hasUnsaved()) return;
			const destination = new URL(link.href, window.location.href);
			if (!/^https?:$/.test(destination.protocol)) return;
			if (link.getAttribute("href")?.startsWith("#") && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			void request().then(accepted => {
				if (!accepted || !link.isConnected || link.href !== destination.href) return;
				// Replay this one approved link so EmDash keeps its normal routing.
				replaying.current = link;
				approvedUnload.current = true;
				try { link.click(); } finally {
					replaying.current = null;
					// A document navigation can raise beforeunload after click returns.
					setTimeout(() => { approvedUnload.current = false; }, 0);
				}
			});
		};
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!approvedUnload.current && guard.current?.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; }
		};
		document.addEventListener("click", beforeLink, true);
		window.addEventListener("beforeunload", beforeUnload);
		return () => {
			document.removeEventListener("click", beforeLink, true);
			window.removeEventListener("beforeunload", beforeUnload);
		};
	}, [request]);
	return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useLeaveGuard(guard: LeaveGuard) {
	const { register } = React.useContext(NavigationContext);
	const latest = React.useRef(guard);
	React.useLayoutEffect(() => { latest.current = guard; });
	React.useLayoutEffect(() => register({
		canLeave: () => latest.current.canLeave(),
		canReplace: () => (latest.current.canReplace ?? latest.current.canLeave)(),
		hasUnsaved: () => latest.current.hasUnsaved(),
	}), [register]);
}

export function useMailNavigation(kind: "leave" | "replace" = "leave") {
	const context = React.useContext(NavigationContext);
	return kind === "replace" ? context.replace : context.allow;
}
