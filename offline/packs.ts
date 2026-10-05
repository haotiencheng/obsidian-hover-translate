import { DataAdapter, requestUrl } from "obsidian";

// Language packs are mirrored to this repo's GitHub release by scripts/mirror-packs.mjs
// (Mozilla Firefox Translations models) and scripts/build-dict.mjs (Wiktionary).
const RELEASE_BASE = "https://github.com/haotiencheng/obsidian-hover-translate/releases/download/packs-v1/";

interface PackFile {
	name: string;
	size: number;
	sha256: string;
}

interface PackIndex {
	version: number;
	models: Record<string, { files: Record<string, PackFile> }>;
	dicts: Record<string, PackFile>;
}

export interface ModelFiles {
	model: ArrayBuffer;
	lex: ArrayBuffer;
	vocabs: ArrayBuffer[];
}

/** Our language codes to the registry's. */
export function mozLang(code: string): string {
	if (code === "zh-TW") return "zh_hant";
	if (code === "zh-CN" || code === "zh") return "zh";
	return code.split("-")[0];
}

/** Chinese variants share one dictionary. */
function dictLang(code: string): string {
	const lang = mozLang(code);
	return lang.startsWith("zh") ? "zh" : lang;
}

/** Registry codes back to ours. */
function ourLang(code: string): string {
	if (code === "zh_hant") return "zh-TW";
	if (code === "zh") return "zh-CN";
	return code;
}

/** Model hops for a pair: direct when Mozilla has it, otherwise through English. */
export function route(from: string, to: string): [string, string][] {
	const a = mozLang(from);
	const b = mozLang(to);
	if (a === b) return [];
	if (a === "en" || b === "en") return [[a, b]];
	return [
		[a, "en"],
		["en", b],
	];
}

export class PackStore {
	private index: Promise<PackIndex> | null = null;

	constructor(private adapter: DataAdapter, private dir: string) {}

	private pairDir(from: string, to: string) {
		return `${this.dir}/packs/${from}_${to}`;
	}

	dictPath(lang: string) {
		return `${this.dir}/packs/dict-${dictLang(lang)}.tsv.gz`;
	}

	async hasPair(from: string, to: string): Promise<boolean> {
		return this.adapter.exists(`${this.pairDir(from, to)}/done`);
	}

	/** True when every hop for this language pair is on disk. */
	async hasRoute(from: string, to: string): Promise<boolean> {
		const hops = route(from, to);
		if (!hops.length) return false;
		for (const [a, b] of hops) if (!(await this.hasPair(a, b))) return false;
		return true;
	}

	/** Source languages (our codes) that have a model into `to`, directly or via English. */
	async sources(to: string): Promise<string[]> {
		const root = `${this.dir}/packs`;
		if (!(await this.adapter.exists(root))) return [];
		const out: string[] = [];
		for (const folder of (await this.adapter.list(root)).folders) {
			const from = (folder.split("/").pop() ?? "").split("_")[0];
			const code = ourLang(from);
			if (from !== "en" && (await this.hasRoute(code, to))) out.push(code);
		}
		return out;
	}

	async hasDict(lang: string): Promise<boolean> {
		return this.adapter.exists(this.dictPath(lang));
	}

	async readPair(from: string, to: string): Promise<ModelFiles> {
		const dir = this.pairDir(from, to);
		const read = (name: string) => this.adapter.readBinary(`${dir}/${name}.bin`);
		const files = await this.adapter.list(dir);
		const has = (name: string) => files.files.some((f) => f.endsWith(`/${name}.bin`));
		const vocabs = has("vocab")
			? [await read("vocab"), await read("vocab")]
			: [await read("srcvocab"), await read("trgvocab")];
		return { model: await read("model"), lex: await read("lex"), vocabs };
	}

	private loadIndex(): Promise<PackIndex> {
		if (!this.index) {
			this.index = requestUrl({ url: `${RELEASE_BASE}packs.json` })
				.then((r) => r.json as PackIndex)
				.catch((err) => {
					this.index = null;
					throw err;
				});
		}
		return this.index;
	}

	/** Download size for a language pair including its dictionary, or 0 if there is no model. */
	async routeSize(from: string, to: string): Promise<number> {
		const index = await this.loadIndex();
		let total = 0;
		for (const [a, b] of route(from, to)) {
			if (await this.hasPair(a, b)) continue;
			const model = index.models[`${a}-${b}`];
			if (!model) return 0;
			total += Object.values(model.files).reduce((n, f) => n + f.size, 0);
		}
		const dict = index.dicts[dictLang(from)];
		if (dict && !(await this.hasDict(from))) total += dict.size;
		return total;
	}

	async downloadRoute(
		from: string,
		to: string,
		onProgress: (done: number, total: number) => void
	): Promise<void> {
		const index = await this.loadIndex();
		const plan: { dir: string; files: [string, PackFile][] }[] = [];
		for (const [a, b] of route(from, to)) {
			if (await this.hasPair(a, b)) continue;
			const model = index.models[`${a}-${b}`];
			if (!model) throw new Error(`No offline model for ${a} → ${b}`);
			plan.push({ dir: this.pairDir(a, b), files: Object.entries(model.files) });
		}
		const total = plan.reduce((n, p) => n + p.files.reduce((m, [, f]) => m + f.size, 0), 0);
		let done = 0;
		onProgress(0, total);
		for (const { dir, files } of plan) {
			await this.mkdirs(dir);
			for (const [name, file] of files) {
				const bytes = await gunzip(await fetchVerified(file));
				await this.adapter.writeBinary(`${dir}/${name}.bin`, bytes);
				done += file.size;
				onProgress(done, total);
			}
			// Marker last, so an interrupted download is never mistaken for a complete one.
			await this.adapter.write(`${dir}/done`, "");
		}
	}

	/** Dictionary packs are optional; returns false when none is published for the language. */
	async downloadDict(lang: string): Promise<boolean> {
		const file = (await this.loadIndex()).dicts[dictLang(lang)];
		if (!file) return false;
		const bytes = await fetchVerified(file);
		await this.mkdirs(`${this.dir}/packs`);
		// Kept compressed; Dictionary.fromGzip inflates it on load.
		await this.adapter.writeBinary(this.dictPath(lang), bytes);
		return true;
	}

	/** Installed packs with their size on disk, for the settings tab. */
	async installed(): Promise<{ name: string; path: string; bytes: number }[]> {
		const root = `${this.dir}/packs`;
		if (!(await this.adapter.exists(root))) return [];
		const listing = await this.adapter.list(root);
		const out: { name: string; path: string; bytes: number }[] = [];
		for (const folder of listing.folders) {
			const files = await this.adapter.list(folder);
			let bytes = 0;
			for (const f of files.files) bytes += (await this.adapter.stat(f))?.size ?? 0;
			out.push({ name: folder.split("/").pop() ?? folder, path: folder, bytes });
		}
		for (const f of listing.files) {
			const name = f.split("/").pop() ?? f;
			out.push({ name, path: f, bytes: (await this.adapter.stat(f))?.size ?? 0 });
		}
		return out;
	}

	async remove(path: string) {
		if ((await this.adapter.stat(path))?.type === "folder") await this.adapter.rmdir(path, true);
		else await this.adapter.remove(path);
	}

	private async mkdirs(path: string) {
		let cur = "";
		for (const part of path.split("/")) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.adapter.exists(cur))) await this.adapter.mkdir(cur);
		}
	}
}

async function fetchVerified(file: PackFile): Promise<ArrayBuffer> {
	const res = await requestUrl({ url: RELEASE_BASE + file.name });
	const digest = await crypto.subtle.digest("SHA-256", res.arrayBuffer);
	const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
	if (hex !== file.sha256) throw new Error(`Checksum mismatch for ${file.name}`);
	return res.arrayBuffer;
}

async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
}
