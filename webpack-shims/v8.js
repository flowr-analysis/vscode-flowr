// Browser/webworker shim for Node's `v8` module.
// flowR only uses `v8.getHeapStatistics()` to skip `source()` resolution under
// memory pressure. There is no equivalent in the web extension host, so we
// report a `heap_size_limit` of 0 which makes flowR's `heap_size_limit > 0`
// guard fall through and simply skip the memory-pressure check.
module.exports = {
	getHeapStatistics() {
		return { used_heap_size: 0, heap_size_limit: 0 };
	}
};
