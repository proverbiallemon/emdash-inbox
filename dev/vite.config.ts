import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
 root: fileURLToPath(new URL(".", import.meta.url)),
 resolve: { alias: { "emdash/plugin-utils": fileURLToPath(new URL("./fixtureApi.ts", import.meta.url)) } },
 server: { host: "127.0.0.1", port: 4317, strictPort: true },
});

