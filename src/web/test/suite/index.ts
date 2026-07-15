import type MochaCtor from 'mocha';
// mocha's package-level "browser" field redirects the bare specifier to a browser-entry that assumes a real DOM
// (an html reporter, `document`/`window` access) - go straight to the class instead, which only needs the
// process/Buffer polyfills webpack already provides for this target
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const Mocha: typeof MochaCtor = require('mocha/lib/mocha.js');

/** entry point `vscode-test-web`'s `--extensionTestsPath` loads and calls inside the webworker extension host */
export function run(): Promise<void> {
	const runner = new Mocha({ ui: 'tdd', color: true, reporter: undefined });
	// the constructor alone does not register the TDD globals (suite/test/...) onto *this* globalThis in a
	// webworker bundle - emit the same "pre-require" event mocha's own file loader would, targeting globalThis
	// explicitly, before loading the test file (which calls those globals at module-load time)
	runner.suite.emit('pre-require', globalThis, '', runner);
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	require('../../../test/web-smoke.test');

	return new Promise((resolve, reject) => {
		try {
			runner.run((failures: number) => failures > 0 ? reject(new Error(`${failures} test(s) failed.`)) : resolve());
		} catch(e) {
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}
