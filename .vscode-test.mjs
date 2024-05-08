import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	version: '1.60.0',
	files: 'out/test/**/*.test.js',
	workspaceFolder: './test-workspace',
	extensionDevelopmentPath: './',
	mocha: {
		timeout: 300000,
		slow: 1100
	}
});
