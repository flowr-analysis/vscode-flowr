import flowr from '@eagleoutice/eslint-config-flowr';

export default [...flowr, {
	ignores: ['dist/', 'out/', 'webpack-shims/', 'webpack.config.js', '.vscode-test*']
}];
