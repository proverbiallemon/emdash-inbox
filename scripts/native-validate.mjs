import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// Native plugins are npm modules. `emdash plugin validate` validates the
// separate sandbox bundle/manifest format, so validate our shipped exports.
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const entry = await import(new URL(pkg.exports["."].default, root));
assert.equal(typeof entry.emdashInboxPlugin, "function", "Missing Astro descriptor factory");
assert.equal(typeof entry.createPlugin, "function", "Missing native runtime factory");
const descriptor = entry.emdashInboxPlugin();
const plugin = entry.createPlugin(descriptor.options);
assert.equal(descriptor.format, "native");
assert.equal(descriptor.entrypoint, pkg.name);
assert.equal(descriptor.adminEntry, `${pkg.name}/admin`);
assert.equal(plugin.id, descriptor.id);
assert.equal(descriptor.version, pkg.version, "Descriptor version must match package version");
assert.equal(plugin.version, pkg.version, "Runtime version must match package version");

const admin = await import(new URL(pkg.exports["./admin"].default, root));
for (const page of descriptor.adminPages ?? []) {
	assert.equal(typeof admin.pages?.[page.path], "function", `Missing admin page ${page.path}`);
}

const tools = Object.entries(plugin.mcp?.tools ?? {});
assert.ok(tools.length > 0, "Native plugin must expose MCP tools");
for (const [name, tool] of tools) {
	const route = plugin.routes[tool.route];
	assert.ok(route, `Missing route for MCP tool ${name}`);
	assert.notEqual(route.public, true, `MCP route ${tool.route} must be private`);
	assert.equal(route.permission, "plugins:manage", `MCP route ${tool.route} must gate inbox access`);
	assert.equal(typeof route.handler, "function");
	assert.equal(route.input, tool.input, `MCP and route input validation must agree for ${name}`);
	assert.equal(z.toJSONSchema(tool.input, { target: "draft-7" }).type, "object");
}

// Exercise the packaged legacy handshake with an empty storage fixture.
// Database-backed route behavior is covered by the native host tests.
const handshake = await plugin.routes["messages/mcp"].handler({
	input: { jsonrpc: "2.0", id: 1, method: "initialize" },
	storage: { messages: { query: async () => ({ items: [] }) } },
	kv: { delete: async () => {} },
});
assert.equal(handshake.result.serverInfo.version, pkg.version, "Legacy MCP handshake version must match package version");

console.log(`Validated native exports for ${pkg.name}@${pkg.version}: ${tools.length} MCP tools, ${descriptor.adminPages.length} admin pages.`);
