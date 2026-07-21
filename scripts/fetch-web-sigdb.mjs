// Bundles the base-R signature shards into the web build (dist/web/sigdb). Browsers cannot download GitHub
// release assets at runtime (no CORS headers on that host), so the web extension ships the small (~140KB)
// base scope directly; the shards are fetched here at build time and hash-verified against the release pointer.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pointerFile = path.join(root, 'node_modules/@eagleoutice/flowr/data/sigdb/sigdb.remote.json');
const outDir = path.join(root, 'dist/web/sigdb');

const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
const wanted = Object.keys(pointer.shards).filter(name =>
	name.startsWith('base.') && name.endsWith('.br') && /\.(manifest|dict|base-current)\./.test(name)
);
if(wanted.length === 0) {
	console.error('fetch-web-sigdb: no matching base shards in the release pointer - the asset naming scheme changed?');
	process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

let failures = 0;
for(const name of wanted) {
	const dest = path.join(outDir, name);
	const expected = pointer.shards[name].sha256;
	if(fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === expected) {
		console.log(`fetch-web-sigdb: have ${name}`);
		continue;
	}
	const url = `https://github.com/${pointer.repo}/releases/download/${pointer.tag}/${encodeURIComponent(name)}`;
	try {
		const res = await fetch(url);
		if(!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const bytes = Buffer.from(await res.arrayBuffer());
		if(sha256(bytes) !== expected) {
			throw new Error('sha256 mismatch');
		}
		fs.writeFileSync(dest, bytes);
		console.log(`fetch-web-sigdb: downloaded ${name} (${bytes.length} bytes)`);
	} catch(e) {
		failures++;
		console.warn(`fetch-web-sigdb: could not fetch ${name}: ${e.message} - the web build will ship without bundled base-R signatures`);
	}
}
process.exit(failures > 0 ? 1 : 0);
