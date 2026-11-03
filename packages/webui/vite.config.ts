import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
	base: command === "build" ? "/webui/" : "/",
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			"/status": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/sessions": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/session": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/worklist": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/model-profiles": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/events": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/resync": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
			"/plugins": { target: process.env.SECHEUR_WEBUI_BRIDGE ?? "http://127.0.0.1:14168" },
		},
	},
	build: {
		outDir: "../../legacy/frontends/desktop/static/webui",
		emptyOutDir: true,
		manifest: true,
		rollupOptions: {
			output: {
				entryFileNames: "assets/app.js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
}));
