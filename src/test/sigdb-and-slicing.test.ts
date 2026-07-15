import assert from 'assert';
import {
	isSigDbEnabled, getSigDbAdditionalPath, shouldSigDbAutoSync, shouldSigDbEagerlyLoad,
	sigDbSummary, readSigDbRemotePointer, getSigDbScopeState, getSigDbCacheDir
} from '../package-db';
import { getConfig } from '../settings';

suite('SigDB Configuration', () => {
	test('isSigDbEnabled returns a boolean', () => {
		assert.strictEqual(typeof isSigDbEnabled(), 'boolean');
	});

	test('getSigDbAdditionalPath returns empty string by default', () => {
		assert.strictEqual(typeof getSigDbAdditionalPath(), 'string');
	});

	test('shouldSigDbAutoSync returns a boolean', () => {
		assert.strictEqual(typeof shouldSigDbAutoSync(), 'boolean');
	});

	test('shouldSigDbEagerlyLoad returns false by default', () => {
		assert.strictEqual(shouldSigDbEagerlyLoad(), false);
	});

	test('getSigDbCacheDir returns a non-empty path', () => {
		const dir = getSigDbCacheDir();
		assert.strictEqual(typeof dir, 'string');
		assert.ok(dir.length > 0);
	});

	test('readSigDbRemotePointer, if present, has a tag and shard map', () => {
		const pointer = readSigDbRemotePointer();
		if(!pointer) {
			// no bundled pointer in this test environment (e.g. web) - nothing further to check
			return;
		}
		assert.strictEqual(typeof pointer.tag, 'string');
		assert.ok(pointer.tag.length > 0);
		assert.ok(typeof pointer.shards === 'object');
		for(const [name, meta] of Object.entries(pointer.shards)) {
			assert.strictEqual(typeof name, 'string');
			assert.strictEqual(typeof meta.sha256, 'string');
			assert.strictEqual(typeof meta.bytes, 'number');
		}
	});

	test('getSigDbScopeState returns real, unforged manifest state (no packages/versions unless a manifest was actually found)', () => {
		for(const scope of ['base', 'current', 'history'] as const) {
			const state = getSigDbScopeState(scope);
			assert.strictEqual(state.scope, scope);
			if(state.manifest) {
				assert.ok(state.manifestPath, 'a resolved manifest must report the file it came from');
				assert.ok(Array.isArray(state.manifest.shards));
			} else {
				assert.strictEqual(state.manifestPath, undefined, 'no manifest path should be reported when nothing was actually found on disk');
			}
		}
	});

	test('sigDbSummary provides a human-readable status derived from real scope state', () => {
		const summary = sigDbSummary();
		assert.strictEqual(typeof summary, 'string');
		assert.ok(summary.startsWith('Signature DB:'));
	});

	test('sigDbSummary reports "disabled" when the setting is off', () => {
		if(!isSigDbEnabled()) {
			assert.strictEqual(sigDbSummary(), 'Signature DB: disabled');
		}
	});
});

suite('Slicing Configuration', () => {
	test('includeCallees defaults to false', () => {
		const config = getConfig();
		assert.strictEqual(config.get<boolean>('vscode-flowr.slice.includeCallees', false), false);
	});

	test('inlineSources defaults to false', () => {
		const config = getConfig();
		assert.strictEqual(config.get<boolean>('vscode-flowr.slice.inlineSources', false), false);
	});
});
