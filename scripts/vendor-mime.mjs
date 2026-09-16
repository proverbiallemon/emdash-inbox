import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "2.7.4";
const patchPath = `patches/postal-mime@${version}.patch`;
const vendorDir = resolve(root, "vendor");
const bundlePath = resolve(vendorDir, "postal-mime.mjs");
const manifestPath = resolve(vendorDir, "postal-mime.provenance.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (pkg.dependencies["postal-mime"] !== version || pkg.pnpm?.patchedDependencies?.[`postal-mime@${version}`] !== patchPath) {
	throw new Error("postal-mime version/patch changed: review the byte-preservation patch and regenerate vendor with pnpm vendor:mime.");
}
const patchSha256 = sha256(await readFile(resolve(root, patchPath)));

async function verifyParser(PostalMime) {
	const raw = 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="check.txt"\r\n\r\nabc\n\r\n--b--\r\n';
	const parsed = await PostalMime.parse(raw);
	if (Buffer.from(parsed.attachments[0].content).toString("hex") !== "6162630a") {
		throw new Error("Unpatched postal-mime: run pnpm install before pnpm vendor:mime. Do not generate the vendor bundle from the upstream decoder.");
	}
}

if (process.argv.includes("--check")) {
	const provenance = JSON.parse(await readFile(manifestPath, "utf8"));
	const bundleSha256 = sha256(await readFile(bundlePath));
	if (provenance.version !== version || provenance.patchSha256 !== patchSha256 || provenance.bundleSha256 !== bundleSha256) {
		throw new Error("Vendored MIME parser is out of sync with its version/patch/provenance. Run pnpm vendor:mime and the MIME byte regressions.");
	}
	await verifyParser((await import(new URL("../vendor/postal-mime.mjs", import.meta.url))).default);
	console.log(`Verified bundled postal-mime ${version} byte-preservation patch.`);
} else {
	const entry = fileURLToPath(import.meta.resolve("postal-mime"));
	const dependencyRoot = resolve(dirname(entry), "..");
	const dependencyPkg = JSON.parse(await readFile(resolve(dependencyRoot, "package.json"), "utf8"));
	if (dependencyPkg.version !== version) throw new Error(`Expected postal-mime ${version}; got ${dependencyPkg.version}.`);
	await verifyParser((await import("postal-mime")).default);
	await mkdir(vendorDir, { recursive: true });
	const { build } = await import("tsdown");
	await build({
		config: false, entry: { "postal-mime": entry }, format: "esm", platform: "neutral",
		dts: false, outDir: vendorDir, clean: false, sourcemap: false, treeshake: false,
		outExtensions: () => ({ js: ".mjs" }), deps: { onlyBundle: false },
	});
	const banner = `/*! postal-mime ${version}, Copyright (c) 2021-2025 Andris Reinman, MIT-0.\n * Generated with scripts/vendor-mime.mjs; local patch: ${patchPath}.\n * See postal-mime-LICENSE.txt and postal-mime.provenance.json. */\n`;
	await writeFile(bundlePath, banner + await readFile(bundlePath, "utf8"));
	await copyFile(resolve(dependencyRoot, "LICENSE.txt"), resolve(vendorDir, "postal-mime-LICENSE.txt"));
	await writeFile(resolve(vendorDir, "postal-mime.d.mts"), 'export { default, addressParser, decodeWords } from "postal-mime";\n');
	await writeFile(manifestPath, JSON.stringify({
		package: "postal-mime", version, upstream: "https://github.com/postalsys/postal-mime", license: "MIT-0",
		patch: patchPath, patchSha256, bundleSha256: sha256(await readFile(bundlePath)),
	}, null, 2) + "\n");
}
