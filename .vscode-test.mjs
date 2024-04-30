import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: './test-workspace',
	extensionDevelopmentPath: './',
	mocha: {
		timeout: 300000,
		slow: 500,
		parallel: false,
		jobs: 1,
	}
});
