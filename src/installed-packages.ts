import { execFile } from 'child_process';
import * as path from 'path';
import { getConfig, Settings } from './settings';
import { isWeb } from './extension';

const RPackageName = /^[A-Za-z][A-Za-z0-9.]*$/;

function rscriptExecutable(): string {
	const rExe = getConfig().get<string>(Settings.Rexecutable, '')?.trim();
	return rExe ? path.join(path.dirname(rExe), 'Rscript') : 'Rscript';
}

/** one-shot R evaluation via Rscript; `undefined` on the web, without R, or on any error */
function runR(code: string): Promise<string | undefined> {
	if(isWeb()) {
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		execFile(rscriptExecutable(), ['--vanilla', '-e', code], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			resolve(err ? undefined : stdout);
		});
	});
}

let installedCache: Promise<Map<string, string> | undefined> | undefined;

/** locally installed packages mapped to their version (same query flowR's own `RShell.installedPackageVersions` runs); `undefined` when R is unavailable */
export function getInstalledPackageVersions(): Promise<Map<string, string> | undefined> {
	installedCache ??= runR('local({ ip <- installed.packages()[,c("Package","Version"),drop=FALSE]; cat(paste(ip[,1], ip[,2], sep="\\t"), sep="\\n") })').then(out => {
		if(out === undefined) {
			return undefined;
		}
		const versions = new Map<string, string>();
		for(const line of out.split('\n')) {
			const tab = line.indexOf('\t');
			if(tab > 0) {
				versions.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim());
			}
		}
		return versions.size > 0 ? versions : undefined;
	});
	return installedCache;
}

/** the locally installed version of `pkg`, if R is available and the package is installed */
export async function getInstalledVersion(pkg: string): Promise<string | undefined> {
	return (await getInstalledPackageVersions())?.get(pkg);
}

export interface HelpDoc {
	/** the Rd topic (help file name) the alias is documented under - the correct final segment for a doc URL */
	topic: string;
	/** the help page's title */
	title: string;
}

const helpIndexCache = new Map<string, Promise<Map<string, HelpDoc> | undefined>>();

/**
 * The real help index of a locally installed package: every documented alias mapped to its Rd topic and title
 * (from the package's own `Meta/Rd.rds`). `undefined` when R is unavailable or the package is not installed.
 */
export function getPackageHelpIndex(pkg: string): Promise<Map<string, HelpDoc> | undefined> {
	if(!RPackageName.test(pkg)) {
		return Promise.resolve(undefined);
	}
	let cached = helpIndexCache.get(pkg);
	if(!cached) {
		const code = `local({ m <- file.path(system.file("Meta", package="${pkg}"), "Rd.rds")
			if(file.exists(m)) { rd <- readRDS(m)
				for(i in seq_len(nrow(rd))) for(a in rd$Aliases[[i]]) cat(a, "\\t", sub("[.][Rr]d$", "", rd$File[i]), "\\t", rd$Title[i], "\\n", sep="") } })`;
		cached = runR(code).then(out => {
			if(!out) {
				return undefined;
			}
			const index = new Map<string, HelpDoc>();
			for(const line of out.split('\n')) {
				const [alias, topic, title] = line.split('\t');
				if(alias && topic) {
					index.set(alias, { topic, title: title ?? '' });
				}
			}
			return index.size > 0 ? index : undefined;
		});
		helpIndexCache.set(pkg, cached);
	}
	return cached;
}

/** the help topic + title for one function of a locally installed package, if documented */
export async function getHelpDoc(pkg: string, fn: string): Promise<HelpDoc | undefined> {
	return (await getPackageHelpIndex(pkg))?.get(fn);
}

/** drops the caches so the next query re-asks R (e.g. after the user installed a package) */
export function refreshInstalledPackages(): void {
	installedCache = undefined;
	helpIndexCache.clear();
}
