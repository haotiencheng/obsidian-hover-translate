// Translation worker. Runs from a blob: URL, so nothing is fetched by path:
// the main thread sends the WASM bytes and a blob: URL for the Emscripten glue.
// Adapted from @browsermt/bergamot-translator worker/translator-worker.js (MPL-2.0).

/* eslint-disable no-undef */
var Module = {};

const GEMM_FALLBACKS = {
	int8_prepare_a: "int8PrepareAFallback",
	int8_prepare_b: "int8PrepareBFallback",
	int8_prepare_b_from_transposed: "int8PrepareBFromTransposedFallback",
	int8_prepare_b_from_quantized_transposed: "int8PrepareBFromQuantizedTransposedFallback",
	int8_prepare_bias: "int8PrepareBiasFallback",
	int8_multiply_and_add_bias: "int8MultiplyAndAddBiasFallback",
	int8_select_columns_of_b: "int8SelectColumnsOfBFallback",
};

const MODEL_CONFIG = [
	"beam-size: 1",
	"normalize: 1.0",
	"word-penalty: 0",
	"cpu-threads: 0",
	"gemm-precision: int8shiftAlphaAll",
	"skip-cost: true",
	"alignment: soft",
	"quiet: true",
	"quiet-translation: true",
	"max-length-break: 128",
	"mini-batch-words: 1024",
	"workspace: 128",
	"max-length-factor: 2.0",
].join("\n");

let service = null;
const models = new Map();

function init({ wasm, glueUrl }) {
	return new Promise((resolve, reject) => {
		Object.assign(Module, {
			instantiateWasm(info, accept) {
				const gemm = Object.fromEntries(
					Object.entries(GEMM_FALLBACKS).map(([key, name]) => [
						key,
						(...args) => Module.asm[name](...args),
					])
				);
				WebAssembly.instantiate(wasm, { ...info, wasm_gemm: gemm })
					.then(({ instance }) => accept(instance))
					.catch(reject);
				return {};
			},
			onRuntimeInitialized() {
				service = new Module.BlockingService({ cacheSize: 0 });
				resolve(true);
			},
		});
		self.Module = Module;
		try {
			importScripts(glueUrl);
		} catch (err) {
			reject(err);
		}
	});
}

function aligned(buffer, alignment) {
	const bytes = new Int8Array(buffer);
	const memory = new Module.AlignedMemory(bytes.byteLength, alignment);
	memory.getByteArrayView().set(bytes);
	return memory;
}

function loadModel({ key, model, lex, vocabs }) {
	if (models.has(key)) return true;
	const unique = vocabs.filter((v, i) => vocabs.indexOf(v) === i);
	const vocabList = new Module.AlignedMemoryList();
	unique.forEach((v) => vocabList.push_back(aligned(v, 64)));
	models.set(
		key,
		new Module.TranslationModel(MODEL_CONFIG, aligned(model, 256), aligned(lex, 64), vocabList, null)
	);
	return true;
}

function unloadModel({ key }) {
	const model = models.get(key);
	if (!model) return false;
	models.delete(key);
	model.delete();
	return true;
}

function translate({ keys, text }) {
	const chain = keys.map((k) => models.get(k));
	if (chain.some((m) => !m)) throw new Error("Model not loaded");
	const input = new Module.VectorString();
	input.push_back(text);
	const options = new Module.VectorResponseOptions();
	options.push_back({ alignment: false, html: false, qualityScores: false });
	const responses =
		chain.length > 1
			? service.translateViaPivoting(chain[0], chain[1], input, options)
			: service.translate(chain[0], input, options);
	const out = responses.get(0).getTranslatedText();
	input.delete();
	options.delete();
	responses.delete();
	return out;
}

const handlers = { init, loadModel, unloadModel, translate };

self.addEventListener("message", async ({ data: { id, name, args } }) => {
	try {
		const result = await handlers[name](args);
		self.postMessage({ id, result });
	} catch (err) {
		self.postMessage({ id, error: String((err && err.message) || err) });
	}
});
