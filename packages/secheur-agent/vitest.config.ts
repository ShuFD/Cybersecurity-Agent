import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{ find: /^stream\/promises$/, replacement: "node:stream/promises" },
				{ find: /^stream$/, replacement: "node:stream" },
				{ find: /^string_decoder$/, replacement: "node:string_decoder" },
			],
		},
		test: {
			environment: "node",
			env: { PI_OFFLINE: "1" },
		},
	}),
);
