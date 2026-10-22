// Prepares a release bump to the given flowR version: records it in the CHANGELOG and prints the release step.
// usage: node scripts/bump-flowr.mjs <flowr-version>
import fs from 'node:fs';
import semver from 'semver';

const flowr = process.argv[2];
if(!semver.valid(flowr)) {
	console.error(`expected a flowR version, got "${flowr}"`);
	process.exit(1);
}

const current = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const date = new Date().toISOString().slice(0, 10);
const entry = `- Update to flowR ${flowr}`;
const lines = fs.readFileSync('CHANGELOG.md', 'utf8').split('\n');

const header = /^# Version (\S+) \(unreleased\)$/.exec(lines[0]);
let next;
if(header) {
	next = header[1];
	lines[0] = `# Version ${next} (${date})`;
	const end = lines.findIndex((l, i) => i > 0 && l.startsWith('# Version '));
	const existing = lines.findIndex((l, i) => i > 0 && (end < 0 || i < end) && l.startsWith('- Update to flowR '));
	if(existing < 0) {
		lines.splice(1, 0, entry);
	} else {
		lines[existing] = lines[existing].replace(/flowR \S+/, `flowR ${flowr}`);
	}
} else {
	next = semver.inc(current, 'patch');
	lines.unshift(`# Version ${next} (${date})`, entry, '');
}

fs.writeFileSync('CHANGELOG.md', lines.join('\n'));
console.log(semver.diff(current, next));
