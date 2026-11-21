// os-browserify lacks userInfo(), which flowR's sigdb cache path calls when process.getuid is missing
const os = require('os-browserify/browser');
module.exports = {
	...os,
	userInfo() {
		return { username: 'web', uid: -1, gid: -1, shell: null, homedir: os.homedir() };
	}
};
