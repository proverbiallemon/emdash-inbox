import * as React from "react";

interface LeaveGuard { canLeave: () => boolean; canReplace?: () => boolean; hasUnsaved: () => boolean }
const NavigationContext = React.createContext<{
	register: (guard: LeaveGuard) => () => void;
	allow: () => boolean;
	replace: () => boolean;
}>({ register: () => () => {}, allow: () => true, replace: () => true });

export function NavigationProvider({ children }: { children: React.ReactNode }) {
	const guard = React.useRef<LeaveGuard | null>(null);
	const value = React.useMemo(() => ({
		register(next: LeaveGuard) { guard.current = next; return () => { if (guard.current === next) guard.current = null; }; },
		allow: () => guard.current?.canLeave() ?? true,
		replace: () => (guard.current?.canReplace ?? guard.current?.canLeave)?.() ?? true,
	}), []);
	React.useEffect(() => {
		// EmDash's sidebar lives outside the plugin's React/portal tree. Capture
		// page links before the host router can unmount an unsaved mail editor.
		const beforeLink = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
			if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
			const destination = new URL(link.href, window.location.href);
			if (!/^https?:$/.test(destination.protocol)) return;
			if (link.getAttribute("href")?.startsWith("#") && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
			if (guard.current && !guard.current.canLeave()) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		};
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (guard.current?.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; }
		};
		document.addEventListener("click", beforeLink, true);
		window.addEventListener("beforeunload", beforeUnload);
		return () => {
			document.removeEventListener("click", beforeLink, true);
			window.removeEventListener("beforeunload", beforeUnload);
		};
	}, []);
	return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useLeaveGuard(guard: LeaveGuard) {
	const { register } = React.useContext(NavigationContext);
	React.useLayoutEffect(() => register(guard), [register, guard]);
}

export function useMailNavigation(kind: "leave" | "replace" = "leave") {
	const context = React.useContext(NavigationContext);
	return kind === "replace" ? context.replace : context.allow;
}
