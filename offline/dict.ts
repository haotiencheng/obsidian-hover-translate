// Offline dictionary lookup over a sorted TSV pack (see scripts/build-dict.mjs).
// The pack stays as raw UTF-8 bytes; only line offsets are indexed, and only the
// matching line is ever decoded.

export interface DictEntry {
	pos: string;
	text: string;
}

const NEWLINE = 10;
const TAB = 9;

export class Dictionary {
	private constructor(private bytes: Uint8Array, private starts: Uint32Array) {}

	static async fromGzip(gz: ArrayBuffer): Promise<Dictionary> {
		const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
		const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
		let count = 0;
		for (let i = 0; i < bytes.length; i++) if (bytes[i] === NEWLINE) count++;
		const starts = new Uint32Array(count);
		let line = 0;
		let start = 0;
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === NEWLINE) {
				starts[line++] = start;
				start = i + 1;
			}
		}
		return new Dictionary(bytes, starts);
	}

	lookup(word: string): DictEntry[] {
		const key = new TextEncoder().encode(word.toLowerCase());
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const cmp = this.compareKey(this.starts[mid], key);
			if (cmp === 0) return this.decode(this.starts[mid]);
			if (cmp < 0) lo = mid + 1;
			else hi = mid - 1;
		}
		return [];
	}

	/** Compare the headword at `start` with `key`, bytewise like the build script's sort. */
	private compareKey(start: number, key: Uint8Array): number {
		for (let i = 0; ; i++) {
			const b = this.bytes[start + i];
			const lineEnded = b === TAB || b === NEWLINE;
			if (i === key.length) return lineEnded ? 0 : 1;
			if (lineEnded) return -1;
			if (b !== key[i]) return b - key[i];
		}
	}

	private decode(start: number): DictEntry[] {
		let end = start;
		while (end < this.bytes.length && this.bytes[end] !== NEWLINE) end++;
		const cols = new TextDecoder().decode(this.bytes.subarray(start, end)).split("\t");
		const out: DictEntry[] = [];
		for (let i = 1; i + 1 < cols.length; i += 2) {
			for (const text of cols[i + 1].split("; ")) out.push({ pos: cols[i], text });
		}
		return out;
	}
}
