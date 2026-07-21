// browser/webworker shim for Node's `zlib`; real brotli decompression backed by brotli-dec-wasm
const zlib = require('browserify-zlib');
const brotli = require('brotli-dec-wasm/web');

let ready = false;

// bytes must be fetched by the caller (via vscode.workspace.fs); webpack's own wasm asset URL 404s under vscode-test-web
function initBrotliSync(wasmBytes) {
	brotli.initSync({ module: wasmBytes });
	ready = true;
}

function brotliDecompressSync(buf) {
	if(!ready) {
		throw new Error('brotli WASM is not initialized yet - initBrotliSync() must run during extension activation before any sigdb read');
	}
	return Buffer.from(brotli.decompress(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
}

module.exports = {
	...zlib,
	constants: {
		...(zlib.constants ?? {}),
		BROTLI_DECODER_PARAM_LARGE_WINDOW: 1
	},
	initBrotliSync,
	brotliDecompressSync
};
