import { defineConfig } from '@vscode/test-cli';

const common = {
	version: '1.92.0',
	workspaceFolder: './test-workspace',
	extensionDevelopmentPath: './',
	mocha: {
		timeout: 300000,
		slow: 1100
	}
};

export default defineConfig([
	{ ...common, label: 'main', files: 'out/test/**/*.test.js' },
	// starts with a file open, so the extension activates while that file is shown
	{ ...common, label: 'startup', files: 'out/test-startup/**/*.test.js', launchArgs: ['./test-workspace/line-categories-example.R'] }
]);
