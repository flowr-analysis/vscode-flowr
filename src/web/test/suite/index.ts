import type MochaCtor from 'mocha';
// mocha's package-level "browser" field redirects the bare specifier to a browser-entry that assumes a real DOM
// (an html reporter, `document`/`window` access) - go straight to the class instead, which only needs the
// process/Buffer polyfills webpack already provides for this target
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const Mocha: typeof MochaCtor = require('mocha/lib/mocha.js');

/* eslint-disable @typescript-eslint/no-require-imports */
// webpack needs static require paths, so the browser-meaningful test files are listed explicitly
const testFiles: (() => void)[] = [
	() => void require('../../../test/concurrency.test'),
	() => void require('../../../test/diagram.test'),
	() => void require('../../../test/hover-values.test'),
	() => void require('../../../test/lint.test'),
	() => void require('../../../test/package-db.test'),
	() => void require('../../../test/rendering.test'),
	() => void require('../../../test/rmd-support.test'),
	() => void require('../../../test/sigdb-and-slicing.test'),
	() => void require('../../../test/slice.test'),
	() => void require('../../../test/utils.test'),
	() => void require('../../../test/refresher.test'),
	() => void require('../../../test/completion.test'),
	() => void require('../../../test/package-info.test'),
	() => void require('../../../test/web-smoke.test'),
	() => void require('../../../test/search.test'),
	() => void require('../../../test/symbols.test'),
	() => void require('../../../test/removal-slice.test'),
];
/* eslint-enable @typescript-eslint/no-require-imports */

/** entry point `vscode-test-web`'s `--extensionTestsPath` loads and calls inside the webworker extension host */
export function run(): Promise<void> {
	const runner = new Mocha({ ui: 'tdd', color: true, reporter: undefined });
	// the constructor alone does not register the TDD globals (suite/test/...) onto *this* globalThis in a
	// webworker bundle - emit the same "pre-require" event mocha's own file loader would, targeting globalThis
	// explicitly, before loading the test file (which calls those globals at module-load time)
	runner.suite.emit('pre-require', globalThis, '', runner);
	for(const load of testFiles) {
		load();
	}

	// mocha's runner registers process listeners via `listenerCount`, which webpack's `process` shim lacks; the resulting
	// rejection is swallowed inside `Mocha#run`, so the run would silently never start
	(process as unknown as { listenerCount?: () => number }).listenerCount ??= () => 0;
	return new Promise((resolve, reject) => {
		try {
			runner.run((failures: number) => failures > 0 ? reject(new Error(`${failures} test(s) failed.`)) : resolve());
		} catch(e) {
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}
