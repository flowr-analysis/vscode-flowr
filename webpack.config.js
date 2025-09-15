const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = env => {
	const telemetry = env.HAS_TELEMETRY;
	console.log(`Building with telemetry ${telemetry}`);

	const nodeExtensionConfig = {
		mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
		target: 'node',
		entry: {
			extension: './src/extension.ts',
			// 'test/suite/index': './src/web/test/suite/index.ts' // source of the web extension test runner
		},
		output: {
			filename: 'extension.js',
			path: path.join(__dirname, './dist/node'),
			libraryTarget: 'commonjs',
			devtoolModuleFilenameTemplate: '../../[resource-path]'
		},
		plugins: [
			new CopyWebpackPlugin({
				patterns: [
					{ from: path.resolve(__dirname, 'resources'), to: 'resources' }
				]
			})
		],
		externals: {
			vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
		},
		resolve: {
			// support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
			mainFields: ['module', 'main'],
			extensions: ['.ts', '.js'],
			alias: {
				// provides alternate implementation for node module and source files
			},
			fallback: {
				// Webpack 5 no longer polyfills Node.js core modules automatically.
				// see https://webpack.js.org/configuration/resolve/#resolvefallback
				// for the list of Node.js core module polyfills.
			}
		},
		module: {
			rules: [
				{
					test: /\.ts$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'ts-loader'
						},
						{
							loader: "ifdef-loader",
							options: {
								"ifdef-triple-slash": false,
								"HAS_TELEMETRY": telemetry
							}
						}
					]
				}
			]
		},
		devtool: 'source-map'
	};

	const webExtensionConfig = {
		mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
		target: 'webworker', // extensions run in a webworker context
		entry: {
			extension: './src/extension.ts',
			// 'test/suite/index': './src/web/test/suite/index.ts' // source of the web extension test runner
		},
		output: {
			filename: 'extension.js',
			path: path.join(__dirname, './dist/web'),
			libraryTarget: 'commonjs',
			devtoolModuleFilenameTemplate: '../../[resource-path]'
		},
		resolve: {
			mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
			extensions: ['.ts', '.js'], // support ts-files and js-files
			alias: {
				// we don't use these modules on the web (we don't start a local flowr server)
				browser: false,
				child_process: false,
				readline: false,
				net: false,
				'fs/promises': false,
				fs: false,
				clipboardy: false,
				'rotating-file-stream': false,
				timers: false
			},
			fallback: {
				// Webpack 5 no longer polyfills Node.js core modules automatically.
				// see https://webpack.js.org/configuration/resolve/#resolvefallback
				// for the list of Node.js core module polyfills.
				assert: require.resolve('assert'),
				path: require.resolve('path-browserify'),
				stream: require.resolve('stream-browserify'),
				util: require.resolve('util'),
				os: require.resolve('os-browserify/browser'),
				zlib: require.resolve('browserify-zlib'),
				constants: require.resolve('constants-browserify'),
				buffer: require.resolve('buffer')
			}
		},
		module: {
			rules: [
				{
					test: /\.ts$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'ts-loader'
						},
						{
							loader: "ifdef-loader",
							options: {
								"ifdef-triple-slash": false,
								"HAS_TELEMETRY": telemetry
							}
						}
					]
				}
			]
		},
		plugins: [
			new webpack.ProvidePlugin({
				Buffer: ['buffer', 'Buffer'],
				process: 'process/browser' // provide a shim for the global `process` variable
			}),
			new CopyWebpackPlugin({
				patterns: [
					{ from: path.resolve(__dirname, 'resources'), to: 'resources' }
				]
			})
		],
		externals: {
			vscode: 'commonjs vscode' // ignored because it doesn't exist
		},
		performance: {
			hints: false
		},
		devtool: 'nosources-source-map' // create a source map that points to the original source file
	};

	return [nodeExtensionConfig, webExtensionConfig];
};
