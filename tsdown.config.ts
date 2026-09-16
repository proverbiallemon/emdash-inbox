import { defineConfig } from "tsdown";
import { fileURLToPath } from "node:url";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		admin: "src/admin.tsx",
	},
	format: "esm",
	dts: true,
	outDir: "dist",
	alias: { "postal-mime": fileURLToPath(new URL("./vendor/postal-mime.mjs", import.meta.url)) },
	// Host provides these — don't bundle.
	deps: { alwaysBundle: ["postal-mime"], neverBundle: [
		"emdash",
		"emdash/plugin-utils",
		"react",
		"react-dom",
		"react/jsx-runtime",
	] },
});
