// Mirrors Mozilla's Firefox Translations models for our languages into dist/packs,
// ready to upload as assets of the `packs-v1` GitHub release, and writes the
// packs.json index the plugin downloads from.
//
//   node scripts/mirror-packs.mjs [out-dir]
//
// Dictionary packs (dict-<lang>.tsv.gz from build-dict.mjs) placed in the same
// folder are added to the index too.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const REGISTRY_URL =
	"https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json";
// Registry codes for the languages in the plugin's language list.
const LANGUAGES = ["zh_hant", "zh", "ja", "ko", "es", "fr", "de", "it", "pt", "ru", "vi", "th", "id"];
// Firefox desktop release first; Android builds are the lower-memory variant.
const STATUS_ORDER = ["Release", "Release Android", "Release Desktop"];
const FILE_NAMES = {
	model: "model",
	lexicalShortlist: "lex",
	vocab: "vocab",
	srcVocab: "srcvocab",
	trgVocab: "trgvocab",
};

const outDir = process.argv[2] ?? "dist/packs";
mkdirSync(outDir, { recursive: true });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function pick(candidates) {
	for (const status of STATUS_ORDER) {
		const matches = candidates.filter((m) => m.releaseStatus === status);
		const best = matches.find((m) => m.architecture === "base-memory") ?? matches[0];
		if (best) return best;
	}
	return null;
}

const registry = await (await fetch(REGISTRY_URL)).json();
const index = { version: 1, generated: new Date().toISOString(), models: {}, dicts: {} };

for (const lang of LANGUAGES) {
	for (const pair of [`${lang}-en`, `en-${lang}`]) {
		const model = pick(registry.models[pair] ?? []);
		if (!model) {
			console.warn(`skip ${pair}: no released model`);
			continue;
		}
		const files = {};
		for (const [key, file] of Object.entries(model.files)) {
			const name = `${pair}.${FILE_NAMES[key]}.bin.gz`;
			const path = `${outDir}/${name}`;
			if (!existsSync(path)) {
				const res = await fetch(`${registry.baseUrl}/${file.path}`);
				if (!res.ok) throw new Error(`${pair} ${key}: HTTP ${res.status}`);
				writeFileSync(path, Buffer.from(await res.arrayBuffer()));
			}
			const buf = readFileSync(path);
			files[FILE_NAMES[key]] = { name, size: buf.length, sha256: sha256(buf) };
		}
		index.models[pair] = {
			architecture: model.architecture,
			releaseStatus: model.releaseStatus,
			source: model.files.model.path.split("/").slice(0, 3).join("/"),
			files,
		};
		const total = Object.values(files).reduce((n, f) => n + f.size, 0);
		console.log(`${pair}: ${model.architecture} (${model.releaseStatus}) ${(total / 1e6).toFixed(1)} MB`);
	}
}

for (const name of readdirSync(outDir).filter((n) => /^dict-.+\.tsv\.gz$/.test(n))) {
	const buf = readFileSync(`${outDir}/${name}`);
	index.dicts[name.slice(5, -7)] = { name, size: buf.length, sha256: sha256(buf) };
}

writeFileSync(`${outDir}/packs.json`, JSON.stringify(index, null, "\t") + "\n");
console.log(`${outDir}/packs.json: ${Object.keys(index.models).length} models, ${Object.keys(index.dicts).length} dictionaries`);
