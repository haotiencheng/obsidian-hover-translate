import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

// The offline engine runs in a blob: worker, so its scripts are bundled as text
// and the WASM binary as gzipped bytes (about 1.8 MB instead of 5 MB).
const embedOfflineEngine = {
	name: "embed-offline-engine",
	setup(build) {
		build.onLoad({ filter: /(offline[\\/]worker|bergamot-translator-worker)\.js$/ }, async (args) => ({
			contents: await readFile(args.path, "utf8"),
			loader: "text",
		}));
		build.onLoad({ filter: /\.wasm$/ }, async (args) => ({
			contents: gzipSync(await readFile(args.path), { level: 9 }),
			loader: "binary",
		}));
	},
};

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["main.ts"],
	plugins: [embedOfflineEngine],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
