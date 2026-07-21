import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { downloadSigDbScope, removeSigDbScope, readSigDbRemotePointer, getSigDbBundleDir, getSigDbScopeState } from '../package-db';
import { SigDbTreeDataProvider } from '../flowr/views/sigdb-view';
import { predownloadBaseRSignatures } from '../extension';
import { getConfig, Settings } from '../settings';

suite('SigDB download/remove', () => {
	let previousCacheDir: string | undefined;
	let tempDir: string;

	setup(() => {
		previousCacheDir = process.env.FLOWR_SIGDB_CACHE;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-flowr-sigdb-test-'));
		process.env.FLOWR_SIGDB_CACHE = tempDir;
	});

	teardown(() => {
		if(previousCacheDir === undefined) {
			delete process.env.FLOWR_SIGDB_CACHE;
		} else {
			process.env.FLOWR_SIGDB_CACHE = previousCacheDir;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('downloading then removing the base scope actually changes what is on disk', async function() {
		this.timeout(30000);
		const pointer = readSigDbRemotePointer();
		if(!pointer) {
			this.skip(); // no bundled release pointer in this build -- nothing to download
			return;
		}

		const dir = getSigDbBundleDir();
		assert.ok(dir, 'a bundle dir should be computable once a pointer is present');
		assert.ok(dir.startsWith(tempDir), 'the bundle dir should honor FLOWR_SIGDB_CACHE');

		let sawDownloading = false;
		const result = await downloadSigDbScope('base', msg => {
			if(msg.startsWith('downloading ')) {
				sawDownloading = true;
			}
		});
		assert.ok(sawDownloading, 'expected at least one real download into a fresh cache dir');
		assert.ok(result.files.length > 0, 'expected at least one downloaded file');
		for(const file of result.files) {
			assert.ok(fs.existsSync(file), `expected downloaded file to exist: ${file}`);
		}

		// re-running against the same cache should skip everything now that it is hash-verified
		let sawHave = false;
		await downloadSigDbScope('base', msg => {
			if(msg.startsWith('have ')) {
				sawHave = true;
			}
		});
		assert.ok(sawHave, 'expected the second download to skip already-verified shards');

		const { removed } = removeSigDbScope('base');
		assert.ok(removed.length > 0, 'expected at least one file to be removed');
		for(const file of result.files) {
			assert.ok(!fs.existsSync(file), `expected removed file to no longer exist: ${file}`);
		}
	});

	// regression test: `shardIdOf()` failed to recognize the manifest asset itself (`<scope>.manifest.json...`)
	// as id `'manifest'`, so a *partial* (shard-filtered) download silently excluded it - leaving shard data on
	// disk that `getSigDbScopeState`/the tree view could never see, since they need the manifest to open anything
	test('a partial (shard-filtered) download still includes the manifest', async function() {
		this.timeout(30000);
		const pointer = readSigDbRemotePointer();
		if(!pointer) {
			this.skip();
			return;
		}
		const result = await downloadSigDbScope('base', undefined, undefined, ['base-current']);
		assert.ok(result.files.some(f => /\.manifest\.json/.test(f)), `expected the manifest among the downloaded files, got: ${result.files.join(', ')}`);
		assert.ok(getSigDbScopeState('base').manifest, 'expected the scope to report a manifest after a partial download');
	});

	// regression test: the manifest lists every package in a scope regardless of which shards are actually on
	// disk (their index is embedded in the manifest itself), but reading a package's *content* (version, exports,
	// dependencies - anything beyond its name) needs the real shard file. The tree view must degrade gracefully
	// for a package whose shard was not part of a partial download, not throw an uncaught ENOENT.
	test('the tree view does not throw when rendering packages from a shard a partial download skipped', async function() {
		this.timeout(60000);
		const pointer = readSigDbRemotePointer();
		if(!pointer) {
			this.skip();
			return;
		}
		// "top" only - deliberately excludes the "current-rest" shard, which real long-tail packages live in
		await downloadSigDbScope('current', undefined, undefined, ['base-current', 'current-top']);
		assert.ok(getSigDbScopeState('current').manifest, 'expected the top-only download to still report a usable manifest');

		const provider = new SigDbTreeDataProvider(vscode.window.createOutputChannel('vscode-flowr-test-sigdb-tree'));
		const packages = await provider.getChildren({ kind: 'scope', scope: 'current' });
		assert.ok(packages.length > 0, 'expected at least one package to be listed from the manifest');
		for(const node of packages) {
			await assert.doesNotReject(provider.getTreeItem(node), `getTreeItem threw for ${JSON.stringify(node)}`);
		}
	});

	// regression test: predownloadBaseRSignatures() used to only log a message and never actually call any
	// download API - base R was never really pre-downloaded no matter how auto-sync was configured
	test('predownloadBaseRSignatures() actually downloads Base R when auto-sync is enabled', async function() {
		this.timeout(30000);
		if(!readSigDbRemotePointer()) {
			this.skip();
			return;
		}
		assert.ok(!getSigDbScopeState('base').manifest, 'expected a fresh temp cache to start with nothing downloaded');

		const config = getConfig();
		const previousAutoSync = config.get<boolean>(Settings.SigDbAutoSync);
		await config.update(Settings.SigDbAutoSync, true, vscode.ConfigurationTarget.Global);
		try {
			await predownloadBaseRSignatures();
		} finally {
			await config.update(Settings.SigDbAutoSync, previousAutoSync, vscode.ConfigurationTarget.Global);
		}

		assert.ok(getSigDbScopeState('base').manifest, 'expected Base R to have actually been downloaded to disk');
	});

	test('removing a scope that was never downloaded removes nothing', () => {
		const pointer = readSigDbRemotePointer();
		if(!pointer) {
			return;
		}
		const { removed } = removeSigDbScope('history');
		assert.deepStrictEqual(removed, []);
	});
});
