const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = env => {
	const telemetry = env.HAS_TELEMETRY ?? false;
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
					{ from: path.resolve(__dirname, 'resources'), to: 'resources' },
					// ship flowR's bundled package database so package information is available by default
					// (it lives in node_modules and would otherwise not be part of the packaged extension)
					// ship flowR's bundled signature database so package information is available by default
					{ from: path.resolve(__dirname, 'node_modules/@eagleoutice/flowr/data/sigdb'), to: 'sigdb' }
				]
			}),
			// webpack 5's node-core externalsPreset does not recognize `node:`-prefixed requests (it treats
			// `node:` as an unhandled URI scheme instead of a module specifier); rewrite it away to the bare
			// core-module name before resolution, so `externalsPresets.node` can externalize it as usual.
			new webpack.NormalModuleReplacementPlugin(/^node:/, resource => {
				resource.request = resource.request.replace(/^node:/, '');
			})
		],
		externalsPresets: {
			node: true
		},
		externals: [
			{ vscode: 'commonjs vscode' }
		],
		resolve: {
			mainFields: ['module', 'main'],
			extensions: ['.ts', '.js'],
			alias: {
				// provides alternate implementation for node module and source files
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
			'test/suite/index': './src/web/test/suite/index.ts'
		},
		output: {
			filename: '[name].js',
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
				timers: false,
				https: false,
				http: false,
				crypto: false,
				'stream/promises': false,
				// `v8` has no web equivalent; provide a shim so heap-pressure checks are no-ops
				v8: path.resolve(__dirname, 'webpack-shims/v8.js')
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
				url: require.resolve('url'),
				zlib: path.resolve(__dirname, 'webpack-shims/zlib.js'),
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
					{ from: path.resolve(__dirname, 'resources'), to: 'resources' },
					// ship flowR's bundled package database (see the node config for details)
					// ship flowR's bundled signature database so package information is available by default
					{ from: path.resolve(__dirname, 'node_modules/@eagleoutice/flowr/data/sigdb'), to: 'sigdb' }
				]
			}),
			// see the node config for why this is needed: webpack treats `node:` as an unhandled URI scheme
			// otherwise. The sigdb reader/downloader modules aren't usable in a webworker anyway (no fs/https),
			// so after rewriting we let `resolve.alias` below stub the bare names out to `false`.
			new webpack.NormalModuleReplacementPlugin(/^node:/, resource => {
				resource.request = resource.request.replace(/^node:/, '');
			})
		],
		externals: [
			{ vscode: 'commonjs vscode' }
		],
		performance: {
			hints: false
		},
		devtool: 'nosources-source-map' // create a source map that points to the original source file
	};

	return [nodeExtensionConfig, webExtensionConfig];
};
