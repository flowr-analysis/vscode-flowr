import { PkgDatabase } from '@eagleoutice/flowr/project/plugins/package-version-plugins/pkgdb';
import { getBundledPackageDbPath } from './extension';
import { getConfig, Settings } from './settings';

/** cached database, keyed by the file path it was loaded from */
let cache: { path: string, db: PkgDatabase } | undefined;

/** whether the package database is enabled via configuration */
export function isPackageDbEnabled(): boolean {
	return getConfig().get<boolean>(Settings.PackageDbEnabled, true);
}

/** the loaded package database (bundled or configured), or `undefined` if disabled/unavailable */
export function getPackageDatabase(output?: { appendLine: (s: string) => void }): PkgDatabase | undefined {
	if(!isPackageDbEnabled()) {
		return undefined;
	}
	const path = getBundledPackageDbPath();
	if(!path) {
		return undefined;
	}
	if(cache?.path === path) {
		return cache.db;
	}
	try {
		const db = PkgDatabase.fromFileSync(path);
		cache = { path, db };
		return db;
	} catch(e) {
		output?.appendLine(`[Package DB] Could not load ${path}: ${(e as Error).message}`);
		return undefined;
	}
}

/** cached summary string, keyed by the config that affects it (so the status-bar hot path never re-loads the DB) */
let summaryCache: { key: string, summary: string } | undefined;

/** a short, human-readable summary of the active package database (for status bar / view headers) */
export function packageDbSummary(): string {
	const enabled = isPackageDbEnabled();
	const custom = getConfig().get<string>(Settings.PackageDbCustomPath, '')?.trim() ?? '';
	const key = `${enabled}|${getBundledPackageDbPath() ?? ''}|${custom}`;
	if(summaryCache?.key === key) {
		return summaryCache.summary;
	}
	let summary: string;
	if(!enabled) {
		summary = 'Package DB: off';
	} else {
		const db = getPackageDatabase();
		summary = db
			? `Package DB: ${db.scope} (${db.content.date})${custom ? ' + custom' : ''}`
			: 'Package DB: unavailable';
	}
	summaryCache = { key, summary };
	return summary;
}
