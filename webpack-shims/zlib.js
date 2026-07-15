// Browser/webworker shim for Node's `zlib` module.
// `browserify-zlib` (webpack's fallback polyfill) implements gzip/deflate but exposes no `.constants` at all,
// so flowR's sigdb codec - which reads `zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW` at module load time,
// unconditionally, not just when actually decompressing - crashes the whole extension on activation. Real
// (de)compression is never invoked in the web build anyway (sigdb needs fs/https, already stubbed out there);
// this only needs to exist so that top-level read does not throw.
const zlib = require('browserify-zlib');
module.exports = {
	...zlib,
	constants: {
		...(zlib.constants ?? {}),
		BROTLI_DECODER_PARAM_LARGE_WINDOW: 1
	}
};
