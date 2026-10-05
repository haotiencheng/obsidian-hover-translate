# Hover Translate

Obsidian plugin for language learners reading foreign-language notes.

- **Hover a word**: after a short pause, a tooltip shows its translation, plus the dictionary form (e.g. "third-person plural of *scottare*").
- **Select a phrase or sentence**: the tooltip translates the whole selection.
- Works in Reading view, Live Preview, and Source mode.
- Translates into your Obsidian language by default (Chinese UI gets Chinese, Japanese UI gets Japanese, and so on). Change it in settings.
- Mobile: select text to translate (no hover on touch screens).
- Toggle from the status bar (`译 → EN`), the ribbon, or the command "Toggle hover translate". `Esc` closes the tooltip.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Source language | Auto | Dropdown; Auto uses the note's `lang:` property or detects it |
| Target language | Auto | Follows Obsidian's language; or pick one |
| Hover delay | 350 ms | |
| Hover modifier key | None | Require Alt/Ctrl/Cmd/Shift to translate on hover |
| Email for MyMemory | empty | Optional, raises daily limit |
| DeepL API key | empty | Optional |

## Offline mode

The first time you translate a language online, the tooltip asks whether to download it for offline use (about 40 MB per language). Say yes and that language is translated on your device from then on: no internet, no limits, nothing leaves your computer. Say "No thanks" and it will not ask again; you can still download or delete packs in settings.

A pack is:

- **Translation model**: Mozilla's Firefox Translations model for that language, run by the [Bergamot](https://browser.mt/) engine bundled in the plugin (WebAssembly, in a background worker). Languages without a direct model go through English, e.g. Italian → English → Traditional Chinese.
- **Dictionary**: a compact word list built from Wiktionary, so a hovered word shows its dictionary form ("third-person plural of *scottare*").

Speed: about 2 seconds the first time after Obsidian starts, then a few milliseconds per lookup. The engine shuts down after 3 minutes idle to give memory back.

## Network use

Online mode sends the hovered word or selected text to the services below; nothing else from your vault is sent, except one sample paragraph per note (up to 300 characters) to detect the note's language. Offline mode sends nothing; the network is only used when you choose to download a pack.

| Service | Used for | Limit |
| --- | --- | --- |
| [MyMemory](https://mymemory.translated.net/doc/spec.php) | Online words and sentences | 5,000 chars/day, or 50,000 with an email in settings |
| [Wiktionary](https://en.wiktionary.org/) | Online single words, into English | None in practice |
| [DeepL](https://www.deepl.com/pro-api) (optional) | Replaces MyMemory when you add an API key | Free plan: 500,000 chars/month |
| [GitHub release `packs-v1`](https://github.com/haotiencheng/obsidian-hover-translate/releases/tag/packs-v1) of this repo | Offline pack downloads, verified by SHA-256 | Only when you choose to download |

Short words are hard to detect, so single-word lookups use the note's language: a `lang:` property in frontmatter (e.g. `lang: it`), or else it is detected once from the note's longest paragraph.

## Offline languages

Models for these languages, each into and out of English: Chinese (Traditional and Simplified), Japanese, Korean, Spanish, French, German, Italian, Portuguese, Russian, Vietnamese, Thai, Indonesian. Other pairs go through English, e.g. Italian → English → Traditional Chinese.

## Building the pack release

```bash
node scripts/mirror-packs.mjs dist/packs          # Mozilla models, gzipped, with SHA-256
curl -LO https://kaikki.org/dictionary/Italian/kaikki.org-dictionary-Italian.jsonl.gz
node scripts/build-dict.mjs kaikki.org-dictionary-Italian.jsonl.gz it dist/packs
node scripts/mirror-packs.mjs dist/packs          # re-run to add dictionaries to packs.json
gh release upload packs-v1 dist/packs/*
```

The plugin reads `packs.json` from the release, so packs can be added or updated without a new plugin version.

## Credits and licenses

- Translation engine: [@browsermt/bergamot-translator](https://github.com/browsermt/bergamot-translator), MPL-2.0.
- Models: [Mozilla Firefox Translations](https://github.com/mozilla/translations), MPL-2.0.
- Dictionary data: [Wiktionary](https://en.wiktionary.org/) via [kaikki.org](https://kaikki.org/), CC BY-SA 4.0.

## Develop

```bash
npm install
npm run dev     # watch build
npm run build   # production build
```

Install by copying `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/hover-translate/`.
