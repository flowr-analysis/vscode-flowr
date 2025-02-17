// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin');

/** @typedef {import('webpack').Configuration} WebpackConfig **/
/** @type WebpackConfig */
const webExtensionConfig = {
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
	target: 'webworker', // extensions run in a webworker context
	entry: {
		extension: './src/extension.ts',
		// 'test/suite/index': './src/web/test/suite/index.ts' // source of the web extension test runner
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
			'fs/promises': path.resolve('./fs-proxy.js'),
			fs: path.resolve('./fs-proxy.js'),
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
			buffer: require.resolve('buffer'),
			timers: require.resolve('timers-browserify'),
			'fs/promises': require.resolve('./fs-proxy.js'),
			fs: require.resolve('./fs-proxy.js'),
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
					}
				]
			}
		]
	},
	plugins: [
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
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
}
module.exports = [webExtensionConfig]
