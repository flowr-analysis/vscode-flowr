// in-memory fs shim for the web build; synchronous, hydrated by package-db.ts/extension.ts before any read
const files = new Map(); // path -> Buffer
const openFiles = new Map(); // fd -> { path }
let nextFd = 1;

// mirrors writes to IndexedDB so a reload doesn't force a full re-download
const IndexedDbName = 'vscode-flowr-sigdb-fs';
const IndexedDbStore = 'files';
let dbPromise;

function openDb() {
	// eslint-disable-next-line no-undef
	if(typeof indexedDB === 'undefined') {
		return Promise.resolve(undefined);
	}
	dbPromise ??= new Promise((resolve, reject) => {
		// eslint-disable-next-line no-undef
		const req = indexedDB.open(IndexedDbName, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(IndexedDbStore);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

async function persistPut(path, data) {
	const db = await openDb();
	if(!db) {
		return;
	}
	await new Promise((resolve, reject) => {
		const tx = db.transaction(IndexedDbStore, 'readwrite');
		tx.objectStore(IndexedDbStore).put(data, path);
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(tx.error);
	});
}

async function persistDelete(path) {
	const db = await openDb();
	if(!db) {
		return;
	}
	await new Promise((resolve, reject) => {
		const tx = db.transaction(IndexedDbStore, 'readwrite');
		tx.objectStore(IndexedDbStore).delete(path);
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(tx.error);
	});
}

async function restoreFromIndexedDb() {
	const db = await openDb();
	if(!db) {
		return;
	}
	await new Promise((resolve, reject) => {
		const tx = db.transaction(IndexedDbStore, 'readonly');
		const req = tx.objectStore(IndexedDbStore).openCursor();
		req.onsuccess = () => {
			const cursor = req.result;
			if(!cursor) {
				resolve(undefined);
				return;
			}
			files.set(cursor.key, Buffer.from(cursor.value));
			cursor.continue();
		};
		req.onerror = () => reject(req.error);
	});
}

function notFound(path) {
	const err = new Error(`ENOENT: no such file or directory, '${path}'`);
	err.code = 'ENOENT';
	return err;
}

function toBuffer(data) {
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function existsSync(path) {
	return files.has(String(path));
}

function mkdirSync() {
	// no directory model - a plain key in `files` is enough
}

function writeFileSync(path, data) {
	const buf = toBuffer(data);
	files.set(String(path), buf);
	void persistPut(String(path), buf).catch(() => { /* best-effort mirror; in-memory copy is still correct */ });
}

function readFileSync(path, encoding) {
	const buf = files.get(String(path));
	if(!buf) {
		throw notFound(path);
	}
	const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
	return enc ? buf.toString(enc) : buf;
}

function readdirSync(dir) {
	const prefix = String(dir).replace(/\/?$/, '/');
	const seen = new Set();
	for(const path of files.keys()) {
		if(path.startsWith(prefix)) {
			const rest = path.slice(prefix.length);
			seen.add(rest.split('/')[0]);
		}
	}
	return [...seen];
}

function openSync(path, flags) {
	if(flags && flags !== 'r') {
		throw new Error(`the vscode-flowr web virtual fs only supports opening files read-only (got flags=${String(flags)})`);
	}
	if(!files.has(String(path))) {
		throw notFound(path);
	}
	const fd = nextFd++;
	openFiles.set(fd, { path: String(path) });
	return fd;
}

function readSync(fd, buffer, offset, length, position) {
	const entry = openFiles.get(fd);
	if(!entry) {
		throw new Error(`EBADF: bad file descriptor (fd=${String(fd)})`);
	}
	const data = files.get(entry.path);
	if(!data) {
		throw notFound(entry.path);
	}
	const start = position ?? 0;
	const n = Math.max(0, Math.min(length, data.length - start));
	if(n > 0) {
		data.copy(buffer, offset, start, start + n);
	}
	return n;
}

function closeSync(fd) {
	openFiles.delete(fd);
}

function copyFileSync(src, dest) {
	const data = files.get(String(src));
	if(!data) {
		throw notFound(src);
	}
	files.set(String(dest), data);
	void persistPut(String(dest), data).catch(() => { /* best-effort mirror */ });
}

function renameSync(oldPath, newPath) {
	const data = files.get(String(oldPath));
	if(!data) {
		throw notFound(oldPath);
	}
	files.delete(String(oldPath));
	files.set(String(newPath), data);
	void persistPut(String(newPath), data)
		.then(() => persistDelete(String(oldPath)))
		.catch(() => { /* best-effort mirror */ });
}

function unlinkSync(path) {
	if(!files.delete(String(path))) {
		throw notFound(path);
	}
	void persistDelete(String(path)).catch(() => { /* best-effort mirror */ });
}

function statSync(path) {
	const data = files.get(String(path));
	if(!data) {
		throw notFound(path);
	}
	return {
		size:        data.length,
		isFile:      () => true,
		isDirectory: () => false
	};
}

module.exports = {
	existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
	openSync, readSync, closeSync, copyFileSync, renameSync, unlinkSync, statSync,
	__vscodeFlowrVirtualFs: { files, hasFile: p => files.has(String(p)), clear: () => files.clear(), restoreFromIndexedDb }
};
