import { App, Notice, Plugin, PluginSettingTab, Setting, getLanguage, Platform, requestUrl } from "obsidian";
import { Dictionary } from "./offline/dict";
import { OfflineEngine } from "./offline/engine";
import { PackStore, route } from "./offline/packs";

type Modifier = "none" | "alt" | "ctrl" | "meta" | "shift";

interface HoverTranslateSettings {
	enabled: boolean;
	sourceLang: string;
	targetLang: string;
	hoverDelay: number;
	modifier: Modifier;
	deeplKey: string;
	email: string;
	useOffline: boolean;
	/** Languages whose offline pack offer was declined. */
	dismissedPacks: string[];
}

const DEFAULT_SETTINGS: HoverTranslateSettings = {
	enabled: true,
	sourceLang: "auto",
	targetLang: "auto",
	hoverDelay: 350,
	modifier: "none",
	deeplKey: "",
	email: "",
	useOffline: true,
	dismissedPacks: [],
};

interface Translation {
	text: string;
	detected: string;
	definitions?: { pos: string; text: string }[];
	offline?: boolean;
}

interface PackOffer {
	from: string;
	to: string;
	bytes: number;
}

// Letters (any script), combining marks, and in-word hyphens.
const WORD_CHAR = /[\p{L}\p{M}\p{N}-]/u;
// Scripts written without spaces between words; these need a dictionary-based word breaker.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Single word, including one word of Chinese, Japanese, or Thai. */
function isSingleWord(text: string): boolean {
	if (/\s/.test(text)) return false;
	if (!UNSPACED.test(text)) return true;
	return Array.from(segmenter.segment(text)).filter((s) => s.isWordLike).length === 1;
}
// Only text inside these containers is translatable.
const TEXT_SCOPE = ".markdown-preview-view, .markdown-rendered, .cm-content";
const MAX_SELECTION = 2000;

const LANGUAGES: Record<string, string> = {
	en: "English",
	"zh-TW": "繁體中文",
	"zh-CN": "简体中文",
	ja: "日本語",
	ko: "한국어",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	it: "Italiano",
	pt: "Português",
	ru: "Русский",
	vi: "Tiếng Việt",
	th: "ไทย",
	id: "Bahasa Indonesia",
};
const SOURCE_LANGUAGES = { auto: "Auto (per note)", ...LANGUAGES };
const TARGET_LANGUAGES = { auto: "Auto (Obsidian language)", ...LANGUAGES };

const DICT_IDLE_MS = 3 * 60 * 1000;

function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Obsidian uses "zh" for Simplified Chinese; translators expect "zh-CN". */
function obsidianLanguage(): string {
	const lang = getLanguage() || "en";
	return lang === "zh" ? "zh-CN" : lang;
}

export default class HoverTranslatePlugin extends Plugin {
	settings: HoverTranslateSettings;
	private tooltip: HTMLElement | null = null;
	private statusEl: HTMLElement;
	private hoverTimer: number | null = null;
	private selectionTimer: number | null = null;
	private lastWordKey = "";
	private mode: "hover" | "selection" | null = null;
	private cache = new Map<string, Translation>();
	private noteLangs = new Map<string, Promise<string>>();
	private requestId = 0;
	private hideTimer: number | null = null;
	packs: PackStore;
	private engine: OfflineEngine;
	private dicts = new Map<string, Promise<Dictionary | null>>();
	private dictTimer: number | null = null;
	private downloading = new Set<string>();

	async onload() {
		await this.loadSettings();
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.packs = new PackStore(this.app.vault.adapter, dir);
		this.engine = new OfflineEngine((from, to) => this.packs.readPair(from, to));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("hover-translate-status");
		this.statusEl.onClickEvent(() => this.toggle());
		this.updateStatus();

		this.addRibbonIcon("languages", "Toggle hover translate", () => this.toggle());
		this.addCommand({
			id: "toggle",
			name: "Toggle hover translate",
			callback: () => this.toggle(),
		});
		this.addCommand({
			id: "translate-selection",
			name: "Translate selection",
			callback: () => this.translateSelection(true),
		});

		this.addSettingTab(new HoverTranslateSettingTab(this.app, this));

		this.registerWindow(document);
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => this.registerWindow(win.doc))
		);
	}

	onunload() {
		this.hideTooltip();
		this.engine.stop();
		this.dicts.clear();
	}

	private registerWindow(doc: Document) {
		this.registerDomEvent(doc, "mousemove", (e) => this.onMouseMove(e));
		this.registerDomEvent(doc, "mouseup", () => this.scheduleSelection());
		// Touch devices have no hover or mouseup; follow selection handles instead.
		this.registerDomEvent(doc, "selectionchange", () => {
			if (Platform.isMobile) this.scheduleSelection();
		});
		this.registerDomEvent(doc, "keyup", (e) => {
			if (e.shiftKey || e.key === "Shift") this.scheduleSelection();
		});
		this.registerDomEvent(doc, "keydown", (e) => {
			if (e.key === "Escape") this.hideTooltip();
		});
		this.registerDomEvent(doc, "scroll", () => this.hideTooltip(), { capture: true });
	}

	async toggle() {
		this.settings.enabled = !this.settings.enabled;
		if (!this.settings.enabled) this.hideTooltip();
		this.updateStatus();
		await this.saveSettings();
	}

	get targetLang(): string {
		const tl = this.settings.targetLang;
		return tl === "auto" ? obsidianLanguage() : tl;
	}

	private updateStatus() {
		const tl = this.targetLang.toUpperCase();
		this.statusEl.setText(this.settings.enabled ? `译 → ${tl}` : "译 off");
		this.statusEl.toggleClass("is-off", !this.settings.enabled);
		this.statusEl.setAttr("aria-label", "Click to toggle hover translate");
	}

	// ---------- hover: single word ----------

	private onMouseMove(e: MouseEvent) {
		if (!this.settings.enabled) return;
		if (this.tooltip && this.tooltip.contains(e.target as Node)) return;
		if (this.mode === "selection") return;
		if (!this.modifierHeld(e)) {
			this.clearHover();
			return;
		}

		const doc = (e.target as Node)?.ownerDocument ?? document;
		const hit = wordAtPoint(doc, e.clientX, e.clientY);
		if (!hit) {
			this.clearHover();
			return;
		}

		const key = `${hit.word}@${Math.round(hit.rect.left)},${Math.round(hit.rect.top)}`;
		if (key === this.lastWordKey) return;
		this.lastWordKey = key;
		this.hideTooltip();
		if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
		this.hoverTimer = window.setTimeout(() => {
			this.hoverTimer = null;
			this.mode = "hover";
			this.show(hit.word, hit.rect, doc);
		}, this.settings.hoverDelay);
	}

	private clearHover() {
		if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
		this.hoverTimer = null;
		this.lastWordKey = "";
		// Short grace period so the pointer can travel into the tooltip to click a button.
		if (this.mode === "hover" && this.tooltip && this.hideTimer === null) {
			this.hideTimer = window.setTimeout(() => {
				this.hideTimer = null;
				if (this.mode === "hover") this.hideTooltip();
			}, 300);
		}
	}

	private modifierHeld(e: MouseEvent): boolean {
		switch (this.settings.modifier) {
			case "alt": return e.altKey;
			case "ctrl": return e.ctrlKey;
			case "meta": return e.metaKey;
			case "shift": return e.shiftKey;
			default: return true;
		}
	}

	// ---------- selection: phrase or sentence ----------

	private scheduleSelection() {
		if (!this.settings.enabled) return;
		if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
		this.selectionTimer = window.setTimeout(() => {
			this.selectionTimer = null;
			this.translateSelection(false);
		}, 150);
	}

	private translateSelection(force: boolean) {
		const doc = activeDocument;
		const sel = doc.getSelection();
		const text = sel?.toString().trim() ?? "";
		if (!sel || sel.rangeCount === 0 || text.length < 2) {
			if (this.mode === "selection") this.hideTooltip();
			return;
		}
		const range = sel.getRangeAt(0);
		const anchor = range.commonAncestorContainer;
		const el = anchor instanceof Element ? anchor : anchor.parentElement;
		if (!force && !el?.closest(TEXT_SCOPE)) return;
		if (this.tooltip && el && this.tooltip.contains(el)) return;

		this.clearHover();
		this.mode = "selection";
		this.show(text.slice(0, MAX_SELECTION), range.getBoundingClientRect(), doc);
	}

	// ---------- tooltip ----------

	private async show(text: string, rect: DOMRect, doc: Document) {
		const id = ++this.requestId;
		const tip = this.ensureTooltip(doc);
		tip.empty();
		tip.toggleClass("is-sentence", this.mode === "selection");
		tip.createDiv({ cls: "hover-translate-loading", text: "…" });
		this.position(tip, rect);

		let result: Translation;
		let offer: PackOffer | null = null;
		try {
			result = await this.translate(text);
			offer = await this.packOffer(result.detected);
		} catch (err) {
			if (id !== this.requestId) return;
			tip.empty();
			const offline = !navigator.onLine;
			tip.createDiv({
				cls: "hover-translate-error",
				text: offline
					? "You are offline. Download a language pack in settings to translate without internet."
					: "Translation failed",
			});
			console.error("hover-translate:", err);
			this.position(tip, rect);
			return;
		}
		if (id !== this.requestId || !this.tooltip) return;

		tip.empty();
		const head = tip.createDiv({ cls: "hover-translate-head" });
		if (this.mode === "hover") head.createSpan({ cls: "hover-translate-source", text });
		head.createSpan({
			cls: "hover-translate-lang",
			text: `${result.detected} → ${this.targetLang}${result.offline ? " · offline" : ""}`,
		});
		if (result.text) tip.createDiv({ cls: "hover-translate-text", text: result.text });
		if (result.definitions?.length) {
			const list = tip.createDiv({ cls: "hover-translate-defs" });
			for (const def of result.definitions.slice(0, 3)) {
				const row = list.createDiv();
				row.createSpan({ cls: "hover-translate-pos", text: def.pos });
				row.createSpan({ text: def.text });
			}
		}
		if (offer) this.renderOffer(tip, offer);

		this.position(tip, rect);
	}

	private renderOffer(tip: HTMLElement, offer: PackOffer) {
		const box = tip.createDiv({ cls: "hover-translate-offer" });
		const mb = Math.max(1, Math.round(offer.bytes / 1e6));
		box.createDiv({
			text: `Translate ${languageName(offer.from)} offline? One-time download, about ${mb} MB.`,
		});
		const buttons = box.createDiv({ cls: "hover-translate-offer-buttons" });
		buttons.createEl("button", { text: "Download", cls: "mod-cta" }).onclick = () => {
			this.hideTooltip();
			this.downloadPack(offer.from, offer.to);
		};
		buttons.createEl("button", { text: "No thanks" }).onclick = async () => {
			this.hideTooltip();
			this.settings.dismissedPacks.push(offer.from);
			await this.saveSettings();
			new Notice("Hover Translate: you can still download it later in settings.");
		};
	}

	/** Offer an offline pack for a language the user reads online, unless declined before. */
	private async packOffer(from: string): Promise<PackOffer | null> {
		const to = this.targetLang;
		if (!this.settings.useOffline || from === "auto" || !from) return null;
		if (from.split("-")[0] === to.split("-")[0]) return null;
		if (this.settings.dismissedPacks.includes(from) || this.downloading.has(from)) return null;
		if (await this.packs.hasRoute(from, to)) return null;
		try {
			const bytes = await this.packs.routeSize(from, to);
			return bytes > 0 ? { from, to, bytes } : null;
		} catch {
			return null;
		}
	}

	/** Drop loaded models and dictionaries, e.g. after a pack is deleted. */
	resetOffline() {
		this.engine.stop();
		this.dicts.clear();
		this.cache.clear();
		this.noteLangs.clear();
	}

	async downloadPack(from: string, to: string) {
		if (this.downloading.has(from)) return;
		this.downloading.add(from);
		const name = languageName(from);
		try {
			await this.packs.downloadRoute(from, to, (done, total) => {
				const pct = total ? Math.floor((done / total) * 100) : 0;
				this.statusEl.setText(`⬇ ${name} ${pct}%`);
			});
			// The dictionary is a bonus; translation works without it.
			const hasDict = await this.packs.downloadDict(from).catch(() => false);
			this.cache.clear();
			this.dicts.delete(from);
			new Notice(
				`Hover Translate: ${name} is ready offline` + (hasDict ? " (with dictionary)." : ".")
			);
		} catch (err) {
			console.error("hover-translate:", err);
			new Notice(`Hover Translate: could not download ${name}. ${String((err as Error).message ?? err)}`);
		} finally {
			this.downloading.delete(from);
			this.updateStatus();
		}
	}

	private ensureTooltip(doc: Document): HTMLElement {
		if (this.tooltip && this.tooltip.ownerDocument !== doc) this.hideTooltip();
		if (!this.tooltip) {
			this.tooltip = doc.body.createDiv({ cls: "hover-translate-tooltip" });
			this.tooltip.addEventListener("mouseenter", () => this.cancelHide());
			this.tooltip.addEventListener("mouseleave", () => {
				if (this.mode === "hover") this.hideTooltip();
			});
		}
		return this.tooltip;
	}

	private position(tip: HTMLElement, rect: DOMRect) {
		const win = tip.ownerDocument.defaultView ?? window;
		const margin = 4;
		const { width, height } = tip.getBoundingClientRect();
		let left = rect.left + rect.width / 2 - width / 2;
		left = Math.max(margin, Math.min(left, win.innerWidth - width - margin));
		let top = rect.bottom + margin;
		if (top + height > win.innerHeight - margin) top = rect.top - height - margin;
		tip.style.left = `${left}px`;
		tip.style.top = `${Math.max(margin, top)}px`;
	}

	private cancelHide() {
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}

	private hideTooltip() {
		this.cancelHide();
		this.requestId++;
		this.tooltip?.remove();
		this.tooltip = null;
		this.mode = null;
		this.lastWordKey = "";
	}

	// ---------- translation backend ----------

	private async translate(text: string): Promise<Translation> {
		const targetLang = this.targetLang;
		const isWord = isSingleWord(text);
		const chosen = this.settings.sourceLang;
		// One word is too short to detect, and the offline engine cannot detect at all,
		// so those borrow the note's language.
		const noteLang = chosen === "auto" ? await this.noteLanguage() : chosen;
		const offline =
			this.settings.useOffline &&
			noteLang !== "auto" &&
			(await this.packs.hasRoute(noteLang, targetLang));
		const sourceLang = offline || isWord ? noteLang : chosen;

		const key = `${offline ? "off" : "on"}|${sourceLang}|${targetLang}|${text}`;
		const cached = this.cache.get(key);
		if (cached) return cached;

		const result = offline
			? await this.translateOffline(text, sourceLang, targetLang, isWord)
			: await this.translateOnline(text, sourceLang, targetLang, isWord);
		if (!result.text && !result.definitions?.length) throw new Error("No translation found");
		if (this.cache.size > 500) this.cache.clear();
		this.cache.set(key, result);
		return result;
	}

	private async translateOffline(
		text: string,
		from: string,
		to: string,
		isWord: boolean
	): Promise<Translation> {
		const dict = isWord ? await this.dictionary(from) : null;
		const definitions = dict?.lookup(text) ?? [];
		let mt = await this.engine.translate(route(from, to), text);
		// Out-of-vocabulary words come back copied ("scottano" -> "They scottano").
		if (mt.toLowerCase().includes(text.toLowerCase())) mt = "";
		return { text: mt, detected: from, definitions, offline: true };
	}

	private async translateOnline(
		text: string,
		sourceLang: string,
		targetLang: string,
		isWord: boolean
	): Promise<Translation> {
		const { deeplKey, email } = this.settings;
		const machine = deeplKey
			? translateDeepL(text, sourceLang, targetLang, deeplKey)
			: translateMyMemory(text, sourceLang, targetLang, email);
		// Single words also get Wiktionary (English only): it names inflections like
		// "third-person plural of scottare", which machine translation often misses.
		const dict =
			isWord && targetLang.startsWith("en") ? lookupWiktionary(text) : Promise.resolve(null);
		const [mt, wk] = await Promise.allSettled([machine, dict]);

		const result: Translation = {
			text: mt.status === "fulfilled" ? mt.value.text : "",
			detected: mt.status === "fulfilled" ? mt.value.detected : sourceLang,
		};
		// MyMemory echoes the input when it has no translation.
		if (result.text.toLowerCase() === text.toLowerCase()) result.text = "";
		if (wk.status === "fulfilled" && wk.value) {
			const lang = result.detected !== "auto" ? result.detected : Object.keys(wk.value)[0];
			result.definitions = wk.value[lang] ?? [];
			if (result.detected === "auto" && lang) result.detected = lang;
		}
		if (!result.text && !result.definitions?.length && mt.status === "rejected") throw mt.reason;
		return result;
	}

	/** Offline dictionary for a language, loaded on demand and dropped when idle. */
	private dictionary(lang: string): Promise<Dictionary | null> {
		if (this.dictTimer !== null) window.clearTimeout(this.dictTimer);
		this.dictTimer = window.setTimeout(() => this.dicts.clear(), DICT_IDLE_MS);
		let dict = this.dicts.get(lang);
		if (!dict) {
			dict = (async () => {
				if (!(await this.packs.hasDict(lang))) return null;
				return Dictionary.fromGzip(await this.app.vault.adapter.readBinary(this.packs.dictPath(lang)));
			})().catch(() => null);
			this.dicts.set(lang, dict);
		}
		return dict;
	}

	/** Note language from a `lang` property, else detected once from its longest paragraph. */
	private noteLanguage(): Promise<string> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return Promise.resolve("auto");
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const declared = fm?.lang ?? fm?.language;
		if (typeof declared === "string" && declared) return Promise.resolve(declared);

		let pending = this.noteLangs.get(file.path);
		if (!pending) {
			pending = (async () => {
				const body = (await this.app.vault.cachedRead(file)).replace(/^---[\s\S]*?\n---/, "");
				const sample = body
					.split(/\n\s*\n/)
					.reduce((a, b) => (b.length > a.length ? b : a), "")
					.slice(0, 300);
				if (sample.length < 20) return "auto";
				const r = await translateMyMemory(sample, "auto", "en", this.settings.email);
				return r.detected || "auto";
			})()
				// Without internet, assume the language of an installed pack.
				.catch(async () => (await this.packs.sources(this.targetLang))[0] ?? "auto");
			this.noteLangs.set(file.path, pending);
		}
		return pending;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.dismissedPacks = [...this.settings.dismissedPacks];
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.cache.clear();
		this.noteLangs.clear();
		this.updateStatus();
	}
}

/**
 * MyMemory public API. No key; 5000 chars/day per IP, or 50000/day when an
 * email is sent with the request.
 */
async function translateMyMemory(
	text: string,
	sl: string,
	tl: string,
	email: string
): Promise<Translation> {
	const source = sl === "auto" ? "autodetect" : sl;
	const params = new URLSearchParams({ q: text, langpair: `${source}|${tl}` });
	if (email) params.set("de", email);
	const res = await requestUrl({ url: `https://api.mymemory.translated.net/get?${params}` });
	const data = res.json as {
		responseStatus?: number | string;
		responseDetails?: string;
		responseData?: { translatedText?: string; detectedLanguage?: string };
	};
	// Quota and input errors come back as HTTP 200 with a status field.
	if (Number(data.responseStatus) !== 200) {
		throw new Error(data.responseDetails || `MyMemory status ${data.responseStatus}`);
	}
	return {
		text: data.responseData?.translatedText ?? "",
		detected: data.responseData?.detectedLanguage ?? sl,
	};
}

/** DeepL target codes differ from ISO for English, Portuguese, and Chinese. */
function deeplTarget(tl: string): string {
	const map: Record<string, string> = {
		en: "EN-US",
		pt: "PT-BR",
		"zh-TW": "ZH-HANT",
		"zh-CN": "ZH-HANS",
		zh: "ZH-HANS",
	};
	return map[tl] ?? tl.split("-")[0].toUpperCase();
}

/** DeepL API. Free keys end in ":fx" and use the api-free host (500k chars/month). */
async function translateDeepL(
	text: string,
	sl: string,
	tl: string,
	key: string
): Promise<Translation> {
	const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
	const body: Record<string, unknown> = { text: [text], target_lang: deeplTarget(tl) };
	if (sl !== "auto") body.source_lang = sl.split("-")[0].toUpperCase();
	const res = await requestUrl({
		url: `https://${host}/v2/translate`,
		method: "POST",
		headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const t = (res.json as { translations?: { text: string; detected_source_language: string }[] })
		.translations?.[0];
	return { text: t?.text ?? "", detected: (t?.detected_source_language ?? sl).toLowerCase() };
}

type WiktionaryEntry = { partOfSpeech: string; definitions: { definition: string }[] };

/** English Wiktionary definitions grouped by source language code, or null if no entry. */
async function lookupWiktionary(word: string): Promise<Record<string, { pos: string; text: string }[]> | null> {
	const tryWord = async (w: string) => {
		const res = await requestUrl({
			url: `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`,
			throw: false,
		});
		return res.status === 200 ? (res.json as Record<string, WiktionaryEntry[]>) : null;
	};
	// Sentence-initial words are capitalised; the dictionary entry usually is not.
	const data = (await tryWord(word.toLowerCase())) ?? (word !== word.toLowerCase() ? await tryWord(word) : null);
	if (!data) return null;

	const parser = new DOMParser();
	const plain = (html: string) =>
		(parser.parseFromString(html, "text/html").body.textContent ?? "").trim();
	const out: Record<string, { pos: string; text: string }[]> = {};
	for (const [lang, entries] of Object.entries(data)) {
		out[lang] = entries.flatMap((e) =>
			e.definitions
				.map((d) => plain(d.definition))
				.filter(Boolean)
				.slice(0, 2)
				.map((text) => ({ pos: e.partOfSpeech.toLowerCase(), text }))
		);
	}
	return out;
}

/** Find the word under the pointer, only if the pointer is actually over its glyphs. */
function wordAtPoint(doc: Document, x: number, y: number): { word: string; rect: DOMRect } | null {
	const caret = doc.caretRangeFromPoint?.(x, y);
	if (!caret) return null;
	const node = caret.startContainer;
	if (node.nodeType !== Node.TEXT_NODE) return null;
	const parent = node.parentElement;
	if (!parent?.closest(TEXT_SCOPE)) return null;

	const text = node.textContent ?? "";
	let start = caret.startOffset;
	let end = caret.startOffset;
	while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
	while (end < text.length && WORD_CHAR.test(text[end])) end++;
	// A run like 我慢慢地睜開了眼睛 is many words; narrow it to the one under the pointer.
	if (UNSPACED.test(text.slice(start, end))) {
		for (const seg of segmenter.segment(text.slice(start, end))) {
			const segStart = start + seg.index;
			if (caret.startOffset >= segStart && caret.startOffset < segStart + seg.segment.length) {
				start = segStart;
				end = segStart + seg.segment.length;
				break;
			}
		}
	}
	const word = text.slice(start, end).replace(/^-+|-+$/g, "");
	if (!word || !/\p{L}/u.test(word)) return null;

	const range = doc.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	// A word can wrap across lines; accept the pointer over any of its line boxes.
	const boxes = Array.from(range.getClientRects());
	const over = boxes.some(
		(r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1
	);
	if (!over) return null;
	return { word, rect: range.getBoundingClientRect() };
}

class HoverTranslateSettingTab extends PluginSettingTab {
	plugin: HoverTranslatePlugin;

	constructor(app: App, plugin: HoverTranslatePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Enabled")
			.setDesc("Also toggled from the status bar, ribbon, or command palette.")
			.addToggle((t) =>
				t.setValue(s.enabled).onChange(async (v) => {
					s.enabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Source language")
			.setDesc("The language you are reading. Auto uses a note's lang property, or detects it.")
			.addDropdown((d) => {
				d.addOptions(SOURCE_LANGUAGES);
				if (!(s.sourceLang in SOURCE_LANGUAGES)) d.addOption(s.sourceLang, s.sourceLang);
				d.setValue(s.sourceLang).onChange(async (v) => {
					s.sourceLang = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Target language")
			.setDesc(`Auto follows Obsidian's language (now: ${obsidianLanguage()}).`)
			.addDropdown((d) => {
				d.addOptions(TARGET_LANGUAGES);
				if (!(s.targetLang in TARGET_LANGUAGES)) d.addOption(s.targetLang, s.targetLang);
				d.setValue(s.targetLang).onChange(async (v) => {
					s.targetLang = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Hover delay (ms)")
			.setDesc("How long to rest on a word before translating it.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 1500, 50)
					.setValue(s.hoverDelay)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.hoverDelay = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hover modifier key")
			.setDesc("Only translate on hover while this key is held. None = always.")
			.addDropdown((d) =>
				d
					.addOptions({ none: "None", alt: "Alt / Option", ctrl: "Ctrl", meta: "Cmd", shift: "Shift" })
					.setValue(s.modifier)
					.onChange(async (v) => {
						s.modifier = v as Modifier;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Email for MyMemory (optional)")
			.setDesc("Raises the free limit from 5,000 to 50,000 characters per day. Sent only to MyMemory.")
			.addText((t) =>
				t.setPlaceholder("you@example.com").setValue(s.email).onChange(async (v) => {
					s.email = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("DeepL API key (optional)")
			.setDesc("Use DeepL instead of MyMemory. The free plan gives 500,000 characters per month.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.deeplKey).onChange(async (v) => {
					s.deeplKey = v.trim();
					await this.plugin.saveSettings();
				});
			});

		this.renderOfflineSection(containerEl);
	}

	private renderOfflineSection(containerEl: HTMLElement) {
		const plugin = this.plugin;
		const s = plugin.settings;
		new Setting(containerEl).setName("Offline language packs").setHeading();

		new Setting(containerEl)
			.setName("Use offline packs")
			.setDesc(
				"Translate on this device with Mozilla's Firefox translation models when a pack is installed. " +
					"You will be asked before anything is downloaded."
			)
			.addToggle((t) =>
				t.setValue(s.useOffline).onChange(async (v) => {
					s.useOffline = v;
					await plugin.saveSettings();
				})
			);

		let pick = Object.keys(LANGUAGES).find((c) => c !== plugin.targetLang && c !== "en") ?? "it";
		if (s.sourceLang !== "auto" && s.sourceLang !== plugin.targetLang) pick = s.sourceLang;
		new Setting(containerEl)
			.setName("Download a pack")
			.setDesc(`Language you read, translated into ${languageName(plugin.targetLang)}.`)
			.addDropdown((d) =>
				d
					.addOptions(LANGUAGES)
					.setValue(pick)
					.onChange((v) => (pick = v))
			)
			.addButton((b) =>
				b
					.setButtonText("Download")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						s.dismissedPacks = s.dismissedPacks.filter((l) => l !== pick);
						await plugin.downloadPack(pick, plugin.targetLang);
						this.display();
					})
			);

		const list = containerEl.createDiv();
		plugin.packs.installed().then((packs) => {
			if (!packs.length) {
				list.createEl("p", { cls: "setting-item-description", text: "No packs installed." });
				return;
			}
			for (const pack of packs) {
				new Setting(list)
					.setName(pack.name.replace("_", " → ").replace(/^dict-(.+)\.tsv\.gz$/, "$1 dictionary"))
					.setDesc(`${(pack.bytes / 1e6).toFixed(1)} MB`)
					.addExtraButton((b) =>
						b
							.setIcon("trash")
							.setTooltip("Delete")
							.onClick(async () => {
								await plugin.packs.remove(pack.path);
								plugin.resetOffline();
								this.display();
							})
					);
			}
		});
	}
}
