import * as React from "react";
import {
	resolveSnoozePreset,
	SNOOZE_PRESETS,
	type SnoozePresetId,
} from "../lib/snoozePresets";

interface Props {
	onConfirm: (iso: string) => void;
	onCancel: () => void;
	/** Pass `true` when `?debug=1` is in the URL to reveal the 1-minute preset. */
	debug: boolean;
}

export function SnoozePicker({ onConfirm, onCancel, debug }: Props) {
	const [customValue, setCustomValue] = React.useState("");
	const [showCustom, setShowCustom] = React.useState(false);

	const handlePreset = (id: SnoozePresetId) => {
		onConfirm(resolveSnoozePreset(id, new Date()));
	};

	const handleCustomConfirm = () => {
		if (!customValue) return;
		const d = new Date(customValue);
		if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return;
		onConfirm(d.toISOString());
	};

	return (
		<div className="absolute z-10 mt-2 right-0 w-64 rounded-lg border bg-popover shadow-lg p-2">
			<div className="flex flex-col">
				{SNOOZE_PRESETS.map((p) => (
					<button
						key={p.id}
						type="button"
						className="text-left text-sm px-3 py-2 rounded hover:bg-muted"
						onClick={() => handlePreset(p.id)}
					>
						{p.label}
					</button>
				))}
				{debug && (
					<button
						type="button"
						className="text-left text-sm px-3 py-2 rounded hover:bg-muted text-amber-500"
						onClick={() => handlePreset("debug1min")}
					>
						[debug] 1 minute
					</button>
				)}
				<button
					type="button"
					className="text-left text-sm px-3 py-2 rounded hover:bg-muted"
					onClick={() => setShowCustom((s) => !s)}
				>
					Custom…
				</button>
				{showCustom && (
					<div className="p-2 space-y-2">
						<input
							type="datetime-local"
							className="w-full border rounded px-2 py-1 text-sm bg-background"
							value={customValue}
							onChange={(e) => setCustomValue(e.target.value)}
						/>
						<div className="flex gap-2 justify-end">
							<button
								type="button"
								className="text-xs px-2 py-1 rounded hover:bg-muted"
								onClick={onCancel}
							>
								Cancel
							</button>
							<button
								type="button"
								className="text-xs px-2 py-1 rounded bg-foreground text-background"
								onClick={handleCustomConfirm}
							>
								Snooze
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
