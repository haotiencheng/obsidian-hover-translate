// Offline machine translation with Mozilla's Bergamot engine in a Web Worker.
// The worker, its glue code, and the WASM binary are all bundled into main.js;
// nothing executable is downloaded. The worker is started on first use and shut
// down after a period of inactivity to give its memory back.

import glueSource from "@browsermt/bergamot-translator/worker/bergamot-translator-worker.js";
import workerSource from "./worker.js";
import wasmGzip from "@browsermt/bergamot-translator/worker/bergamot-translator-worker.wasm";
import { ModelFiles } from "./packs";

const IDLE_MS = 3 * 60 * 1000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class OfflineEngine {
	private worker: Worker | null = null;
	private ready: Promise<void> | null = null;
	private urls: string[] = [];
	private pending = new Map<number, Pending>();
	private nextId = 0;
	private loaded = new Set<string>();
	private idleTimer: number | null = null;

	constructor(private readModel: (from: string, to: string) => Promise<ModelFiles>) {}

	async translate(hops: [string, string][], text: string): Promise<string> {
		await this.start();
		for (const [from, to] of hops) await this.ensureModel(from, to);
		const result = await this.call("translate", { keys: hops.map(([a, b]) => `${a}-${b}`), text });
		this.touch();
		return result as string;
	}

	stop() {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.worker?.terminate();
		this.worker = null;
		this.ready = null;
		this.loaded.clear();
		for (const p of this.pending.values()) p.reject(new Error("Offline engine stopped"));
		this.pending.clear();
		this.urls.forEach((u) => URL.revokeObjectURL(u));
		this.urls = [];
	}

	private touch() {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => this.stop(), IDLE_MS);
	}

	private start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = (async () => {
			const blobUrl = (src: string) => {
				const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
				this.urls.push(url);
				return url;
			};
			const glueUrl = blobUrl(glueSource);
			this.worker = new Worker(blobUrl(workerSource));
			this.worker.onmessage = ({ data: { id, result, error } }) => {
				const p = this.pending.get(id);
				if (!p) return;
				this.pending.delete(id);
				if (error) p.reject(new Error(error));
				else p.resolve(result);
			};
			const wasm = await gunzip(wasmGzip);
			await this.call("init", { wasm, glueUrl }, [wasm]);
		})();
		this.ready.catch(() => this.stop());
		return this.ready;
	}

	private async ensureModel(from: string, to: string) {
		const key = `${from}-${to}`;
		if (this.loaded.has(key)) return;
		const files = await this.readModel(from, to);
		await this.call("loadModel", { key, ...files });
		this.loaded.add(key);
	}

	private call(name: string, args: unknown, transfer: Transferable[] = []): Promise<unknown> {
		const worker = this.worker;
		if (!worker) return Promise.reject(new Error("Offline engine not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, name, args }, transfer);
		});
	}
}

async function gunzip(bytes: Uint8Array): Promise<ArrayBuffer> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
}
