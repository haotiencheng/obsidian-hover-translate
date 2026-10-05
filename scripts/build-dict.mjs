// Builds a compact offline dictionary pack from a kaikki.org (Wiktionary) dump.
//
//   node scripts/build-dict.mjs <kaikki.jsonl.gz> <lang-code> [out-dir]
//
// Output: <out-dir>/dict-<lang>.tsv.gz, one line per lowercase headword, sorted
// by UTF-8 bytes so the plugin can binary-search it without parsing:
//   word \t pos \t gloss; gloss \t pos \t gloss ...
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const [input, lang, outDir = "dist"] = process.argv.slice(2);
if (!input || !lang) {
	console.error("usage: node scripts/build-dict.mjs <kaikki.jsonl.gz> <lang-code> [out-dir]");
	process.exit(1);
}

const MAX_SENSES = 3;
const MAX_GLOSS = 120;
const clean = (s) => s.replace(/[\t\n]+/g, " ").trim();

/** word -> Map<pos, glosses[]> */
const words = new Map();
const lines = createInterface({ input: createReadStream(input).pipe(createGunzip()) });
for await (const line of lines) {
	const entry = JSON.parse(line);
	if (!entry.word || !entry.senses) continue;
	const glosses = [];
	for (const sense of entry.senses) {
		// glosses runs from general to specific; the last one is the actual meaning.
		const g = sense.glosses?.[sense.glosses.length - 1];
		if (!g) continue;
		const text = clean(g).slice(0, MAX_GLOSS);
		if (!glosses.includes(text)) glosses.push(text);
		if (glosses.length >= MAX_SENSES) break;
	}
	if (!glosses.length) continue;
	const key = clean(entry.word).toLowerCase();
	if (!words.has(key)) words.set(key, new Map());
	const byPos = words.get(key);
	const list = byPos.get(entry.pos) ?? [];
	for (const g of glosses) if (list.length < MAX_SENSES && !list.includes(g)) list.push(g);
	byPos.set(entry.pos, list);
}

const keys = [...words.keys()]
	.map((k) => [k, Buffer.from(k)])
	.sort((a, b) => Buffer.compare(a[1], b[1]))
	.map(([k]) => k);

mkdirSync(outDir, { recursive: true });
const out = `${outDir}/dict-${lang}.tsv.gz`;
function* rows() {
	for (const k of keys) {
		const cols = [k];
		for (const [pos, glosses] of words.get(k)) cols.push(pos, glosses.join("; "));
		yield cols.join("\t") + "\n";
	}
}
await pipeline(Readable.from(rows()), createGzip({ level: 9 }), createWriteStream(out));
console.log(`${out}: ${keys.length} headwords`);
