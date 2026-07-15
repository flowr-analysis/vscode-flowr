import * as vscode from 'vscode';
import { Settings } from '../../settings';
import { baseRPackages, isSigDbEnabled } from '../../package-db';

export const FlowrProjectViewId = 'flowr-project';

const ProjectContextKey = 'vscode-flowr:hasProject';

type MatchStatus = 'matched' | 'base' | 'unmatched' | 'db-unavailable';

interface LibraryMatch {
	status:       MatchStatus;
	dbVersion?:   string;
	exportCount?: number;
}

/** Classify a declared library against base R packages and the signature database */
export function classifyLibrary(name: string): LibraryMatch {
	if(baseRPackages.has(name)) {
		return { status: 'base' };
	}
	if(!isSigDbEnabled()) {
		return { status: 'db-unavailable' };
	}
	return { status: 'unmatched' };
}

interface DeclaredLibrary {
	name:             string;
	/** version as declared in the manifest (if any) */
	declaredVersion?: string;
}

interface ProjectManifest {
	/** absolute path of the manifest file */
	uri:             vscode.Uri;
	/** short, human-readable label (relative to the workspace folder) */
	label:           string;
	/** e.g. `renv`, `DESCRIPTION`, `rv` */
	kind:            string;
	/** the package this manifest itself describes (from a `DESCRIPTION`'s `Package:` field), if any */
	packageName?:    string;
	/** the version this manifest declares for itself (from a `DESCRIPTION`'s `Version:` field), if any */
	packageVersion?: string;
	libraries:       DeclaredLibrary[];
}

/** the tree is two levels deep: manifests at the top, their libraries below */
type ProjectNode =
	| { type: 'manifest', manifest: ProjectManifest }
	| ({ type: 'library', manifest: ProjectManifest, library: DeclaredLibrary } & LibraryMatch);

type LibraryNode = Extract<ProjectNode, { type: 'library' }>;

/** how a given match status is surfaced in the tree (icon, themable color, short badge and a tooltip) */
interface StatusPresentation {
	icon:    string;
	color?:  string;
	badge:   (node: LibraryNode) => string;
	tooltip: (node: LibraryNode) => string;
}

const statusPresentations: Record<MatchStatus, StatusPresentation> = {
	matched: {
		icon:    'pass',
		color:   'testing.iconPassed',
		badge:   node => `in DB: v${node.dbVersion}`,
		tooltip: node => `\`${node.library.name}\` is in the package database (v${node.dbVersion}, ${node.exportCount} exported identifiers).`
	},
	base: {
		icon:    'library',
		badge:   () => 'bundled with R',
		tooltip: node => `\`${node.library.name}\` is a base package that is part of R itself.`
	},
	unmatched: {
		icon:    'circle-slash',
		color:   'testing.iconFailed',
		badge:   () => 'not in package DB',
		tooltip: node => `\`${node.library.name}\` was not found in the package database. flowR cannot resolve its exports or definitions.`
	},
	'db-unavailable': {
		icon:    'question',
		badge:   () => 'package DB unavailable',
		tooltip: node => `The package database is disabled or could not be loaded, so \`${node.library.name}\` could not be matched.`
	}
};

/**
 * Registers the "Project" sidebar view: detects R manifests (renv/DESCRIPTION/rv) in the workspace and shows,
 * per declared library, whether flowR's package database knows it.
 */
export function registerProjectView(output: vscode.OutputChannel): { dispose: () => void } {
	const data = new FlowrProjectTreeView(output);
	const disposables: vscode.Disposable[] = [];
	let treeView: vscode.TreeView<ProjectNode> | undefined;

	// re-scan when project manifests appear/change/disappear or the workspace layout changes
	const watcher = vscode.workspace.createFileSystemWatcher('**/{renv.lock,DESCRIPTION,rv.lock,rproject.toml}');
	const refresh = () => void data.refresh();
	watcher.onDidCreate(refresh);
	watcher.onDidChange(refresh);
	watcher.onDidDelete(refresh);
	disposables.push(
		watcher,
		vscode.workspace.onDidChangeWorkspaceFolders(refresh),
		vscode.workspace.onDidChangeConfiguration(e => {
			if(e.affectsConfiguration(Settings.Category)) {
				refresh();
			}
		})
	);

	// The view is contributed behind a `when: vscode-flowr:hasProject` clause so it stays hidden until a manifest
	// is found. Some editors (e.g. Positron) do not register a `when`-hidden view yet, so creating the tree view
	// while the context is unset errors with "No view is registered". We therefore enable the context first, then
	// create the view, then let refresh() set the real state (hiding it again when there is no project).
	void (async() => {
		await vscode.commands.executeCommand('setContext', ProjectContextKey, true);
		try {
			treeView = vscode.window.createTreeView(FlowrProjectViewId, { treeDataProvider: data });
			data.setTreeView(treeView);
		} catch(e) {
			output.appendLine(`[Project View] Could not create the tree view: ${(e as Error).message}`);
		}
		await data.refresh();
	})();

	return {
		dispose: () => {
			treeView?.dispose();
			data.dispose();
			for(const d of disposables) {
				d.dispose();
			}
		}
	};
}

class FlowrProjectTreeView implements vscode.TreeDataProvider<ProjectNode> {
	private readonly output: vscode.OutputChannel;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProjectNode | undefined>();
	readonly onDidChangeTreeData          = this._onDidChangeTreeData.event;
	private manifests:       ProjectManifest[] = [];
	private tv:              vscode.TreeView<ProjectNode> | undefined;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	setTreeView(tv: vscode.TreeView<ProjectNode>): void {
		this.tv = tv;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	async refresh(): Promise<void> {
		this.manifests = await detectManifests(this.output);
		// drive the view's `when` clause: the Project tab is only shown once we actually found a manifest
		void vscode.commands.executeCommand('setContext', ProjectContextKey, this.manifests.length > 0);
		if(this.tv) {
			const total = this.manifests.reduce((n, m) => n + m.libraries.length, 0);
			this.tv.message = `Found ${this.manifests.length} manifest${this.manifests.length === 1 ? '' : 's'} declaring ${total} librar${total === 1 ? 'y' : 'ies'}.`;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	private classify(library: DeclaredLibrary): LibraryMatch {
		return classifyLibrary(library.name);
	}

	getTreeItem(element: ProjectNode): vscode.TreeItem {
		if(element.type === 'manifest') {
			return manifestTreeItem(element.manifest);
		}
		return libraryTreeItem(element);
	}

	getChildren(element?: ProjectNode): ProjectNode[] {
		if(!element) {
			return this.manifests.map(manifest => ({ type: 'manifest', manifest }));
		}
		if(element.type === 'manifest') {
			return element.manifest.libraries.map(library => ({
				type:     'library' as const,
				manifest: element.manifest,
				library,
				...this.classify(library)
			}));
		}
		return [];
	}
}

function manifestTreeItem(manifest: ProjectManifest): vscode.TreeItem {
	// when the manifest describes a package itself (a DESCRIPTION), surface that package's name and version
	const libraryCount = `${manifest.libraries.length} librar${manifest.libraries.length === 1 ? 'y' : 'ies'}`;
	const item = new vscode.TreeItem(manifest.packageName ?? manifest.label, vscode.TreeItemCollapsibleState.Expanded);
	item.description = [manifest.packageVersion && `v${manifest.packageVersion}`, manifest.kind, libraryCount].filter(Boolean).join(' · ');
	item.iconPath = new vscode.ThemeIcon('package');
	item.resourceUri = manifest.uri;
	const title = manifest.packageName
		? `\`${manifest.packageName}\`${manifest.packageVersion ? ` v${manifest.packageVersion}` : ''} — ${manifest.kind}`
		: `Detected ${manifest.kind} manifest`;
	item.tooltip = new vscode.MarkdownString(`${title}\n\n\`${manifest.uri.fsPath}\``);
	item.command = { command: 'vscode.open', title: 'Open manifest', arguments: [manifest.uri] };
	return item;
}

function libraryTreeItem(node: LibraryNode): vscode.TreeItem {
	const present = statusPresentations[node.status];
	const item = new vscode.TreeItem(node.library.name, vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon(present.icon, present.color ? new vscode.ThemeColor(present.color) : undefined);
	const declared = node.library.declaredVersion ? `declared ${node.library.declaredVersion}` : undefined;
	item.description = [declared, present.badge(node)].filter(Boolean).join(' · ');
	item.tooltip = new vscode.MarkdownString(present.tooltip(node));
	return item;
}

/* ------------------------------------------------------------------ detection ------------------------------------------------------------------ */

/** binds a manifest file name to the project kind it represents and the parsers that read it */
interface ManifestDetector {
	file:  string;
	kind:  string;
	parse: (content: string) => DeclaredLibrary[];
	/** optional: extract the package this manifest describes itself (name/version) */
	meta?: (content: string) => { packageName?: string, packageVersion?: string };
}

const manifestDetectors: readonly ManifestDetector[] = [
	{ file: 'renv.lock', kind: 'renv', parse: parseRenvLock },
	{ file: 'DESCRIPTION', kind: 'DESCRIPTION', parse: parseDescription, meta: parseDescriptionMeta },
	{ file: 'rv.lock', kind: 'rv', parse: parseRvLock },
	{ file: 'rproject.toml', kind: 'rv', parse: parseRvToml }
];

async function detectManifests(output: vscode.OutputChannel): Promise<ProjectManifest[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const manifests: ProjectManifest[] = [];
	for(const folder of folders) {
		for(const { file, kind, parse, meta } of manifestDetectors) {
			const uri = vscode.Uri.joinPath(folder.uri, file);
			let content: string;
			try {
				content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			} catch{
				continue; // file does not exist
			}
			try {
				manifests.push({ uri, label: file, kind, ...meta?.(content), libraries: dedupeLibraries(parse(content)) });
			} catch(e) {
				output.appendLine(`[Project View] Failed to parse ${uri.fsPath}: ${(e as Error).message}`);
				manifests.push({ uri, label: file, kind, libraries: [] });
			}
		}
	}
	return manifests;
}

/** Removes empty names and the `R` pseudo-package, collapses duplicates (keeping the first), and sorts by name. */
export function dedupeLibraries(libraries: DeclaredLibrary[]): DeclaredLibrary[] {
	const seen = new Map<string, DeclaredLibrary>();
	for(const lib of libraries) {
		if(!lib.name || lib.name === 'R') {
			continue;
		}
		if(!seen.has(lib.name)) {
			seen.set(lib.name, lib);
		}
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Extracts the declared packages (with versions) from a `renv.lock` file's `Packages` object. */
export function parseRenvLock(content: string): DeclaredLibrary[] {
	const lock = JSON.parse(content) as { Packages?: Record<string, { Package?: string, Version?: string }> };
	if(!lock.Packages) {
		return [];
	}
	return Object.entries(lock.Packages).map(([key, entry]) => ({
		name:            entry.Package ?? key,
		declaredVersion: entry.Version
	}));
}

/** Extracts the package this `DESCRIPTION` describes itself: its `Package:` name and `Version:`. */
export function parseDescriptionMeta(content: string): { packageName?: string, packageVersion?: string } {
	const field = (name: string) => new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm').exec(content.replace(/\r\n/g, '\n'))?.[1].trim();
	return { packageName: field('Package'), packageVersion: field('Version') };
}

/** Extracts the packages listed in the `Depends`/`Imports`/`Suggests`/`LinkingTo` fields of a `DESCRIPTION` file. */
export function parseDescription(content: string): DeclaredLibrary[] {
	// DESCRIPTION is a DCF file; the dependency fields are comma-separated, possibly wrapped across lines
	const fields = ['Depends', 'Imports', 'Suggests', 'LinkingTo'];
	const libraries: DeclaredLibrary[] = [];
	// unfold continuation lines (which start with whitespace) into their field
	const unfolded = content.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
	for(const line of unfolded.split('\n')) {
		const match = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
		if(!match || !fields.includes(match[1])) {
			continue;
		}
		for(const part of match[2].split(',')) {
			const dep = /^\s*([A-Za-z][A-Za-z0-9._]*)\s*(?:\(([^)]*)\))?/.exec(part);
			if(dep) {
				libraries.push({ name: dep[1], declaredVersion: dep[2]?.trim() || undefined });
			}
		}
	}
	return libraries;
}

/** Extracts the packages from an `rv.lock` TOML file's `[[packages]]` tables. */
export function parseRvLock(content: string): DeclaredLibrary[] {
	// rv.lock is TOML with [[packages]] tables carrying name = "..." / version = "..."
	const libraries: DeclaredLibrary[] = [];
	let name: string | undefined;
	let version: string | undefined;
	const flush = () => {
		if(name) {
			libraries.push({ name, declaredVersion: version });
		}
		name = undefined;
		version = undefined;
	};
	for(const raw of content.split('\n')) {
		const line = raw.trim();
		if(/^\[\[.*\]\]$/.test(line)) {
			flush();
			continue;
		}
		const n = /^name\s*=\s*"([^"]+)"/.exec(line);
		if(n) {
			name = n[1];
		}
		const v = /^version\s*=\s*"([^"]+)"/.exec(line);
		if(v) {
			version = v[1];
		}
	}
	flush();
	return libraries;
}

/** Extracts the packages from the `dependencies = [ ... ]` array of an `rproject.toml` (rv) file. */
export function parseRvToml(content: string): DeclaredLibrary[] {
	// rproject.toml declares dependencies as an array of names (possibly with inline detail tables)
	const libraries: DeclaredLibrary[] = [];
	const depsMatch = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(content);
	if(!depsMatch) {
		return libraries;
	}
	let body = depsMatch[1];
	// inline detail tables carry the package under `name = "..."`; collect those, then strip the tables so
	// their other keys (e.g. `repository = "CRAN"`) are not mistaken for package names
	const inlineTable = /\{[^}]*\}/g;
	let table: RegExpExecArray | null;
	while((table = inlineTable.exec(body)) !== null) {
		const name = /\bname\s*=\s*"([A-Za-z][A-Za-z0-9._]*)"/.exec(table[0]);
		if(name) {
			libraries.push({ name: name[1] });
		}
	}
	body = body.replace(inlineTable, '');
	// the remaining entries are bare quoted package names
	const bare = /"([A-Za-z][A-Za-z0-9._]*)"/g;
	let m: RegExpExecArray | null;
	while((m = bare.exec(body)) !== null) {
		libraries.push({ name: m[1] });
	}
	return libraries;
}
