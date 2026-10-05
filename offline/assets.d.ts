declare module "*.wasm" {
	const bytes: Uint8Array;
	export default bytes;
}
declare module "*worker.js" {
	const source: string;
	export default source;
}
