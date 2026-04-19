import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		admin: "src/admin.tsx",
	},
	format: "esm",
	dts: true,
	outDir: "dist",
	// Host provides these — don't bundle.
	external: [
		"emdash",
		"emdash/plugin-utils",
		"postal-mime",
		"react",
		"react-dom",
		"react/jsx-runtime",
	],
});
