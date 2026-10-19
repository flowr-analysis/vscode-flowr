import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from '../../extension';
import type { FunctionInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/function-info/function-info';
import type { DefaultDependencyCategoryName, DependenciesQuery, DependenciesQueryResult, DependencyCategoryName, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import { Unknown } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import { Identifier as IdentifierUtil } from '@eagleoutice/flowr/dataflow/environments/identifier';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { rangeToVscodeRange, RotaryBuffer } from '../utils';
import { dataFlowOf, describePlots } from './plot-label';
import type { DefaultsMaps } from '../../settings';
import { DependencyViewRefresherConfigKeys, Settings, getConfig, isVerbose } from '../../settings';
import { resolveSigDbPackageVersion, getSigDbScopeState } from '../../package-db';
import { getInstalledPackageVersions } from '../../installed-packages';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import { ConfigurableRefresher, isRTypeLanguage, RefreshType } from '../../configurable-refresher';
import type { GuessDepVersionsQueryResult, GuessEvidenceSource } from '@eagleoutice/flowr/queries/catalog/guess-dep-versions-query/guess-dep-versions-query-format';
import { isNotUndefined } from '@eagleoutice/flowr/util/assert';


const FlowrDependencyViewId = 'flowr-dependencies';

const Defaults = {
	DependenciesQueryEnabledCategories: [],
	DependencyViewUpdateType:           RefreshType.Adaptive,
	DependencyViewUpdateInterval:       10,
	DependencyViewAdaptiveBreak:        5000,
	DependencyViewCacheLimit:           3,
	DependencyViewKeepOnError:          true,
	DependencyViewAutoReveal:           5,
} satisfies DefaultsMaps;


const dplyr = ['mutate', 'transmute', 'filter', 'select', 'rename', 'relocate', 'arrange', 'summarise', 'summarize', 'group_by', 'ungroup', 'distinct', 'count', 'slice',
	'left_join', 'right_join', 'inner_join', 'full_join', 'semi_join', 'anti_join', 'bind_rows', 'bind_cols'];
const tidyr = ['pivot_longer', 'pivot_wider', 'gather', 'spread', 'separate', 'unite', 'drop_na', 'fill', 'replace_na', 'nest', 'unnest'];
/** calls that reshape, filter, join or aggregate data; flowR has no such category, so the extension adds it */
export const TransformFunctions: FunctionInfo[] = [
	...dplyr.map(name => ({ package: 'dplyr', name })),
	...tidyr.map(name => ({ package: 'tidyr', name })),
	...['merge', 'subset', 'transform', 'within', 'rbind', 'cbind'].map(name => ({ package: 'base', name })),
	...['aggregate', 'reshape', 'na.omit'].map(name => ({ package: 'stats', name }))
];

/** the `dependencies` + `location-map` queries the dependency view runs, built from the user's settings (shared with the line indicators) */
export function buildDependencyQueries() {
	const config = getConfig();
	const overrides = config.get<Omit<DependenciesQuery, 'type' | 'ignoreDefaultFunctions'>>(Settings.DependenciesQueryOverrides);
	return [
		{
			type:                   'dependencies',
			ignoreDefaultFunctions: config.get<boolean>(Settings.DependenciesQueryIgnoreDefaults, false),
			enabledCategories:      config.get<DependencyCategoryName[]>(Settings.DependenciesQueryEnabledCategories, Defaults.DependenciesQueryEnabledCategories),
			...overrides,
			additionalCategories:   { transform: { queryDisplayName: 'Data Transformations', functions: TransformFunctions }, ...overrides?.additionalCategories }
		},
		{
			type: 'location-map'
		}
	] as const satisfies [DependenciesQuery, { type: 'location-map' }];
}

/** registers the Dependency View's internal commands (go-to, enable/disable category, guess versions) */
export function registerDependencyInternalCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	registerCommand(context, 'vscode-flowr.internal.goto.dependency', (dependency: Dependency) => {
		const node = dependency.getNodeId();
		const loc = dependency.getLocation();
		if(node) {
			// move the cursor there too, not just scroll into view, so this behaves like a real "go to"
			const editor = vscode.window.activeTextEditor;
			if(editor && loc) {
				setTimeout(() => {
					const range = rangeToVscodeRange(loc);
					editor.selection = new vscode.Selection(range.start, range.start);
					editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
				}, 50);
			}
		}
	});
	registerCommand(context, 'vscode-flowr.internal.enable-disable.dependency', (dependency: Dependency) => {
		let values = new Set<DependencyCategoryName>(getConfig().get<DependencyCategoryName[]>(Settings.DependenciesQueryEnabledCategories, Defaults.DependenciesQueryEnabledCategories));
		if(!values.size) {
			// empty array means all are enabled, so we add them here to make the edit easier
			values = new Set<DependencyCategoryName>(Object.keys(dependencyDisplayInfo));
		}
		if(values.has(dependency.category)) {
			values.delete(dependency.category);
		} else {
			values.add(dependency.category);
		}
		output.appendLine(`Toggling dependency category ${dependency.category}, new value ${[...values].join(', ')}`);
		getConfig().update(Settings.DependenciesQueryEnabledCategories, [...values]);
	});
	registerCommand(context, 'vscode-flowr.dependencyView.guessVersions', async() => {
		const doc = vscode.window.activeTextEditor?.document;
		if(!doc || !isRTypeLanguage(doc)) {
			vscode.window.showWarningMessage('Open an R file to guess its dependency versions.');
			return;
		}
		try {
			const session = await getFlowrSession();
			const { result, hasError } = await session.retrieveQuery(doc, [{ type: 'guess-dep-versions' }]);
			if(hasError || !result['guess-dep-versions']) {
				throw new Error('query returned no result');
			}
			// without the full CRAN history scope, guesses can only be checked against currently-available
			// versions - a package that needs an older release to satisfy a constraint would look unsatisfiable
			const historyDownloaded = !!getSigDbScopeState('history').manifest;
			if(!historyDownloaded) {
				vscode.window.showWarningMessage(
					'The full CRAN history signature database isn\'t downloaded - guessed versions may miss older releases. Sync it from the Signature DB view for more accurate results.'
				);
			}
			const file = await vscode.workspace.openTextDocument({ language: 'markdown', content: formatGuessVersionsReport(result['guess-dep-versions'], historyDownloaded) });
			await vscode.window.showTextDocument(file, { preview: true });
			await vscode.commands.executeCommand('markdown.showPreview', file.uri);
		} catch(e) {
			output.appendLine(`[Dependency View] guess-dep-versions failed: ${e instanceof Error ? e.message : String(e)}`);
			vscode.window.showErrorMessage('Failed to guess dependency versions (see the flowR output channel).');
		}
	});
}

// mirrors the executor's own `reallyConstrained` predicate (guess-dep-versions-query-executor.js): a dependency only
// becomes a counted factor in runnableCombinations/possibleCombinations if evidence actually narrows it - date/available
// bounds alone don't count. If nothing in the whole result qualifies, the product is the empty-product identity (1/1),
// not a real "1 of N combinations survive" - showing that as "100%" next to per-package counts in the hundreds reads as
// a contradiction, so report it as N/A instead of a misleading percentage.
const ReallyConstrainingSources = new Set<GuessEvidenceSource>(['declared', 'transitive', 'signature', 'indirect']);

/** a Markdown report of a `guess-dep-versions` query result, reusing flowR's own human-readable evidence `detail` strings */
function formatGuessVersionsReport(result: GuessDepVersionsQueryResult, historyDownloaded: boolean): string {
	const lines = [
		'# Guessed Dependency Versions',
		'',
		[result.rVersion && `R ${result.rVersion}`, result.dateCutoff && `up to ${result.dateCutoff}`, `${result.dependencies.length} dependencies`].filter(Boolean).join(' · '),
		''
	];
	if(!historyDownloaded) {
		lines.push('> ⚠ The full CRAN history signature database isn\'t downloaded - only currently-available versions were considered, so an older release that would satisfy a constraint may be missing or reported as unsatisfiable. Sync it from the Signature DB view for more accurate results.', '');
	}
	if(result.message) {
		lines.push(`> ${result.message}`, '');
	}
	if(result.runnableCombinations !== undefined && result.possibleCombinations) {
		const hasConstrainingEvidence = result.dependencies.some(dep => dep.evidence.some(ev => ReallyConstrainingSources.has(ev.source)));
		if(hasConstrainingEvidence) {
			const pct = Math.round(result.runnableCombinations / result.possibleCombinations * 100);
			lines.push(`**Runnable combinations:** ${result.runnableCombinations} / ${result.possibleCombinations} (${pct}%)`, '');
		} else {
			lines.push('**Runnable combinations:** N/A (no constraining evidence found)', '');
		}
	}
	for(const group of result.linkedGroups ?? []) {
		lines.push(`**Linked:** ${group.join(' + ')}`, '');
	}
	for(const dep of result.dependencies) {
		const tag = dep.base ? ' _(base)_' : dep.used === false ? ' _(not used)_' : '';
		lines.push(`## ${dep.package}${tag}`, '');
		lines.push(dep.unsatisfiable ? '**Unsatisfiable** - no version satisfies every constraint.' : `**Range:** \`${dep.range}\``);
		if(dep.totalVersions !== undefined) {
			lines.push(`(${dep.candidateCount}/${dep.totalVersions} versions survive)`);
		}
		lines.push('');
		for(const ev of dep.evidence) {
			lines.push(`- ${ev.detail}`);
		}
		if(dep.evidence.length > 0) {
			lines.push('');
		}
	}
	return lines.join('\n');
}

/** returns disposer */
export function registerDependencyView(output: vscode.OutputChannel): { dispose: () => void, update: () => Promise<Dependency[] | undefined> } {
	const data = new FlowrDependencyTreeView(output);
	const reveal = vscode.commands.registerCommand(RevealCommand, revealDependency);
	const grayed = vscode.window.registerFileDecorationProvider({
		provideFileDecoration: uri => uri.scheme === GrayedScheme ? { color: new vscode.ThemeColor('disabledForeground') } : undefined
	});
	const tv = vscode.window.createTreeView(
		FlowrDependencyViewId,
		{
			treeDataProvider: data
		}
	);

	let refreshDescDisposable: vscode.Disposable | undefined;

	function refreshDesc() {
		let message: string;
		if(!isRTypeLanguage(vscode.window.activeTextEditor?.document)) {
			message = 'In an R script, this view ';
		} else {
			message = 'This view ';
		}
		if(refreshDescDisposable) {
			refreshDescDisposable.dispose();
			refreshDescDisposable = undefined;
		}
		switch(getConfig().get<string>(Settings.DependencyViewUpdateType, Defaults.DependencyViewUpdateType)) {
			case 'interval': {
				const secs = getConfig().get<number>(Settings.DependencyViewUpdateInterval, Defaults.DependencyViewUpdateInterval);
				message += `updates every ${secs} second${secs === 1 ? '' : 's'}`;
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(Settings.DependencyViewAdaptiveBreak, Defaults.DependencyViewAdaptiveBreak);
				if(getActiveEditorCharLength() > breakOff) {
					const secs = getConfig().get<number>(Settings.DependencyViewUpdateInterval, Defaults.DependencyViewUpdateInterval);
					message += `updates every ${secs} second${secs === 1 ? '' : 's'} (adaptively)`;
					refreshDescDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() <= breakOff) {
							refreshDesc();
						}
					});
				} else {
					message += 'updates on every change (adaptively)';
					refreshDescDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() > breakOff) {
							refreshDesc();
						}
					});
				}
				break;
			}
			case 'on save': message += 'updates on save'; break;
			case 'on change': message += 'updates on every change'; break;
			case 'never': default:
				message += 'does not update automatically'; break;
		}
		message += ' and shows the dependencies (configure it in the settings).';
		tv.message = message;
	}

	refreshDesc();
	const disposeChange = vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(Settings.Category)) {
			refreshDesc();
		}
	});
	const disposeChangeActive = vscode.window.onDidChangeActiveTextEditor(() => {
		refreshDesc();
	});


	data.setTreeView(tv);
	return {
		dispose: () => {
			grayed.dispose();
			reveal.dispose();
			data.dispose();
			disposeChange.dispose();
			disposeChangeActive.dispose();
			if(refreshDescDisposable) {
				refreshDescDisposable.dispose();
			}
		},
		update: async() => {
			await data.refresh(true);
			return await data.getChildren() as Dependency[] | undefined;
		}
	};
}

/** drops edits that cannot move or change any dependency (trailing whitespace, comment-only lines) while keeping line positions intact */
export function textFingerprint(text: string): string {
	return text.replace(/[ \t]+$|^[ \t]*#.*$/gm, '').trimEnd();
}

const emptyDependencies: DependenciesQueryResult = {
	library: [], source: [], read: [], write: [], visualize: [], test: [], undeclared: [], unused: [], '.meta': { timing: -1 }
} as unknown as DependenciesQueryResult;
const emptyLocationMap: LocationMapQueryResult = { map: {
	files: [],
	ids:   {}
}, '.meta': { timing: -1 } };
export interface DependencyCategoryInfo { name: string, verb: string, icon: string, useReverseLinks?: boolean }
/** the categories shown in the overview; `undeclared`/`unused` are deliberately excluded */
export type DisplayedCategoryName = Exclude<DefaultDependencyCategoryName, 'undeclared' | 'unused'> | 'transform';
/** in the order of an analysis: set up, load data, transform it, analyze, check, then communicate the results */
export const dependencyDisplayInfo: Record<DisplayedCategoryName, DependencyCategoryInfo> = {
	'library':    { name: 'Libraries', verb: 'loads the library', icon: 'library' },
	'remote':     { name: 'Remote Installs', verb: 'installs', icon: 'cloud-download' },
	'source':     { name: 'Sourced Scripts', verb: 'sources the script', icon: 'file-code' },
	'read':       { name: 'Imported Data', verb: 'imports the data', icon: 'file-text' },
	'transform':  { name: 'Data Transformations', verb: 'transforms the data', icon: 'filter' },
	'statistics': { name: 'Statistical Tests', verb: 'performs statistical test', icon: 'search' },
	'test':       { name: 'Tests', verb: 'tests for', icon: 'beaker' },
	'visualize':  { name: 'Visualizations', verb: 'visualizes the data', icon: 'graph', useReverseLinks: true },
	'write':      { name: 'Outputs', verb: 'produces the output', icon: 'new-file' }
};
type Update = Dependency | undefined | null;
class FlowrDependencyTreeView implements vscode.TreeDataProvider<Dependency> {
	private readonly output:               vscode.OutputChannel;
	private activeDependencies:            DependenciesQueryResult = emptyDependencies;
	private locationMap:                   LocationMapQueryResult = emptyLocationMap;
	private readonly _onDidChangeTreeData: vscode.EventEmitter<Update> = new vscode.EventEmitter<Update>();
	readonly onDidChangeTreeData:          vscode.Event<Update> = this._onDidChangeTreeData.event;
	private disposables:                   vscode.Disposable[] = [];
	private parent:                        vscode.TreeView<Dependency> | undefined;
	private rootElements:                  Dependency[] | undefined;
	private refresher:                     ConfigurableRefresher;

	constructor(output: vscode.OutputChannel) {
		this.output = output;

		this.refresher = new ConfigurableRefresher({
			name:            'Dependency View',
			keys:            DependencyViewRefresherConfigKeys,
			refreshCallback: async() => {
				/* Gets called when the analysis should be refreshed */
				await this.refresh();
			},
			configChangedCallback: () => {
				/* Gets called when config changes, or update behaviour changes */
				const configuredBufSize = getConfig().get<number>(Settings.DependencyViewCacheLimit, Defaults.DependencyViewCacheLimit);
				if(this.textBuffer.size() !== configuredBufSize) {
					this.textBuffer = new RotaryBuffer(configuredBufSize);
				}
			},
			clearCallback: () => {
				/* Gets called when a non R file is opened */
				this.activeDependencies = emptyDependencies;
				this.locationMap = emptyLocationMap;
				this.rootElements = [];
				this.lastFile = '';
				this.lastText = '';
				this._onDidChangeTreeData.fire(undefined);
			},
			output: output
		});

		/* lazy startup patches */
		setTimeout(() => void this.refresh(), 500);
	}

	public setTreeView(tv: vscode.TreeView<Dependency>) {
		this.parent = tv;
		this.disposables.push(
			// on sidebar visibility change
			tv.onDidChangeVisibility(async() => {
				if(tv.visible) {
					await this.refresh();
				}
			})
		);
	}

	async getDependenciesForActiveFile(document?: vscode.TextDocument): Promise<{ dep: DependenciesQueryResult, loc: LocationMapQueryResult, ast?: NormalizedAst, dfi?: DataflowInformation, partial?: boolean } | 'error'> {
		// use the document captured by the caller so a mid-analysis editor switch can't store A's deps under B
		const doc = document ?? vscode.window.activeTextEditor?.document;
		if(!doc) {
			return { dep: emptyDependencies, loc: emptyLocationMap };
		}
		const session = await getFlowrSession();
		const now = Date.now();
		const { result, hasError, dfi, ast } = await session.retrieveQuery(doc, buildDependencyQueries());
		const total = Date.now() - now;
		if(hasError) {
			this.output.appendLine('[Dependency View] Error: Could not retrieve dependencies (parser error)');
			if(result.dependencies && result['location-map']) {
				this.output.appendLine(`[Dependency View] Refreshed (partially) in ${total}ms! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
				return { dep: result.dependencies, loc: result['location-map'], ast, dfi, partial: true };
			} else {
				return 'error';
			}
		}
		this.output.appendLine(`[Dependency View] Refreshed in ${total}ms! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
		return { dep: result.dependencies, loc: result['location-map'], ast, dfi };
	}

	private working = false;
	/** when the current refresh started, used to recover from a wedged `working` flag (see {@link refresh}) */
	private workingSince = 0;
	private textBuffer: RotaryBuffer<[{ content: string, path: string }, { dep: DependenciesQueryResult, loc: LocationMapQueryResult, ast?: NormalizedAst, dfi?: DataflowInformation }]> = new RotaryBuffer(0);
	private lastText = '';
	private lastFile = '';

	/** shows why the view may be stale or incomplete next to its title (cleared with `undefined`) */
	private setProblem(problem: string | undefined) {
		if(this.parent) {
			this.parent.description = problem && `⚠ ${problem}`;
		}
	}

	public async refresh(force = false) {
		// clear `working` on a forced refresh, or if a prior run has been stuck implausibly long (never wedge auto-refresh)
		if(this.working && (force || Date.now() - this.workingSince > 15_000)) {
			this.working = false;
		}
		if(!this.parent?.visible || !vscode.window.activeTextEditor || this.working || (!force && !isRTypeLanguage(vscode.window.activeTextEditor?.document))) {
			if(force) {
				this.output.appendLine('[Dependency View] Do not force refresh (visible: ' + this.parent?.visible + ', working: ' + this.working + ', language: ' + vscode.window.activeTextEditor?.document.languageId + ')');
			} else if(isVerbose()) {
				this.output.appendLine('[Dependency View] Do not refresh (visible: ' + this.parent?.visible + ', working: ' + this.working + ', language: ' + vscode.window.activeTextEditor?.document.languageId + ')');
			}
			return;
		}
		// capture the active document once so an editor switch mid-analysis can't mix up which file the results belong to
		const document = vscode.window.activeTextEditor?.document;
		const text = textFingerprint(document?.getText());
		const file = document?.uri.fsPath;
		if(!force && text === this.lastText && file === this.lastFile) {
			if(isVerbose()) {
				this.output.appendLine('[Dependency View] Do not refresh (no change)');
			}
			return;
		} else {
			this.lastText = text ?? '';
			this.lastFile = file ?? '';
		}
		this.output.appendLine('[Dependency View] Refreshing dependencies' + (force ? ' (forced)' : ''));
		this.working = true;
		this.workingSince = Date.now();
		try {
			const has = !force && this.textBuffer.get(e => e?.[0].path === document?.uri.fsPath && e?.[0].content === text);
			if(has) {
				try {
					this.output.appendLine(`[Dependency View] Using cached dependencies (Dependencies: ${has[1].dep['.meta'].timing}ms, Locations: ${has[1].loc['.meta'].timing}ms)`);
				} catch(e) {
					this.output.appendLine(`[Dependency View] Error: ${(e as Error).message}`);
					this.output.appendLine((e as Error).stack ?? '');
				}
				this.activeDependencies = has[1].dep;
				this.locationMap = has[1].loc;
				// the cached entry carries the same ast/dfi a fresh analysis would, so slicing still works on a cache hit
				await this.makeRootElements(has[1].dfi, has[1].ast);
				this._onDidChangeTreeData.fire(undefined);
				return;
			}
			await vscode.window.withProgress({ location: { viewId: FlowrDependencyViewId } }, () => {
				return this.getDependenciesForActiveFile(document).then(async res => {
					if(res === 'error') {
						const keep = getConfig().get<boolean>(Settings.DependencyViewKeepOnError, Defaults.DependencyViewKeepOnError);
						this.setProblem(keep ? 'flowR could not analyze the file, showing the last result' : 'flowR could not analyze the file');
						if(keep) {
							// keep the old tree but forget the fingerprint, so the next edit re-analyzes instead of being deduped
							this.lastText = '';
							return;
						} else {
							this.activeDependencies = emptyDependencies;
							this.locationMap = emptyLocationMap;
							await this.makeRootElements();
							this._onDidChangeTreeData.fire(undefined);
							return;
						}
					}
					this.setProblem(res.partial ? 'the file has syntax errors, results may be incomplete' : undefined);
					this.activeDependencies = res.dep;
					this.locationMap = res.loc;
					this.textBuffer.push([{ content: text, path: document?.uri.fsPath ?? '' }, res]);
					await this.makeRootElements(res.dfi, res.ast);
					this._onDidChangeTreeData.fire(undefined);
				}).catch(e => {
					this.output.appendLine(`[Dependency View] Error: ${(e as Error).message}`);
					this.output.appendLine((e as Error).stack ?? '');
				});
			});
		} catch(e) {
			this.output.appendLine('[Dependency View] Error: Could not refresh dependencies');
			this.output.appendLine((e as Error).message);
			this.output.appendLine((e as Error).stack ?? '');
		} finally {
			this.working = false;
			setTimeout(() => void this.reveal(), 0);
		}
	}

	private async reveal() {
		if(!this.parent?.visible) {
			return;
		}
		const children = await this.getChildren();
		const autoRevealUntil = getConfig().get<number>(Settings.DependencyViewAutoReveal, Defaults.DependencyViewAutoReveal);
		for(const root of children ?? []) {
			if(root.children?.length && root.children.length <= autoRevealUntil) {
				this.parent?.reveal(root, { select: false, focus: false, expand: true });
			}
		}
	}

	getTreeItem(element: Dependency): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}

	getChildren(element?: Dependency): vscode.ProviderResult<Dependency[]> {
		if(element) {
			return element.children ?? [];
		} else {
			return this.rootElements;
		}
	}

	getParent(element: Dependency): vscode.ProviderResult<Dependency> {
		return element.getParent();
	}

	/** the signature database's resolved version and the locally installed version for every distinctly-named `library()`/`require()` dependency */
	private async resolveLibraryVersions(): Promise<Map<string, LibraryVersionInfo>> {
		const names = new Set((this.activeDependencies.library as DependencyInfo[] | undefined)?.map(l => l.value).filter((v): v is string => !!v && v !== Unknown));
		const installedVersions = await getInstalledPackageVersions();
		const resolved = await Promise.all([...names].map(async name => [name, {
			db:        await resolveSigDbPackageVersion(name),
			installed: installedVersions === undefined ? undefined : installedVersions.get(name) ?? null
		}] as const));
		return new Map(resolved.filter(([, info]) => info.db !== undefined || info.installed !== undefined));
	}

	private async makeRootElements(dfi?: DataflowInformation, ast?: NormalizedAst) {
		const libraryVersions = await this.resolveLibraryVersions();
		const uniqueIds = new Set<string>();
		plotLabels = describePlots(this.activeDependencies.visualize ?? [], this.activeDependencies.write ?? [], ast);
		const roots = Object.entries(dependencyDisplayInfo).map(([d, i]) => {
			const result = this.activeDependencies[d] as DependencyInfo[];
			return this.makeDependency(i.name, i.verb, result, new vscode.ThemeIcon(i.icon, categoryColor(d)), d, i, dfi, ast, libraryVersions).enforceUniqueIds(uniqueIds);
		});
		// categories without findings go to the bottom, grayed out below a separator
		const empty = roots.filter(r => !r.children?.length);
		for(const r of empty) {
			r.iconPath = new vscode.ThemeIcon(dependencyDisplayInfo[r.category as DisplayedCategoryName].icon, new vscode.ThemeColor('disabledForeground'));
			r.resourceUri = vscode.Uri.from({ scheme: GrayedScheme, path: `/${r.category}` });
		}
		this.rootElements = [...roots.filter(r => r.children?.length), ...empty.length > 0 ? [noFindingsSeparator()] : [], ...empty];
	}

	private makeDependency(label: string, verb: string, elements: DependencyInfo[], themeIcon: vscode.ThemeIcon, category: DependencyCategoryName, categoryInfo: DependencyCategoryInfo, dfi?: DataflowInformation, ast?: NormalizedAst, libraryVersions?: Map<string, LibraryVersionInfo>): Dependency {
		const parent = new Dependency({ label, category, categoryInfo, icon: themeIcon, root: true, verb, children: this.makeChildren(elements, verb, category, categoryInfo, dfi, ast, libraryVersions), ast, dfi, allInfos: elements, libraryVersions });
		parent.children?.forEach(c => c.setParent(parent));
		return parent;
	}

	private makeChildren(elements: DependencyInfo[], verb: string, category: DependencyCategoryName, categoryInfo: DependencyCategoryInfo, dfi?: DataflowInformation, ast?: NormalizedAst, libraryVersions?: Map<string, LibraryVersionInfo>): Dependency[] {
		// we exclude dependency infos that are already displayed through the useReverseLinks setting
		const elementsToShow = categoryInfo.useReverseLinks ? elements.filter(i => !i.linkedIds) : elements;
		return makeGroupedElements(this.locationMap, elementsToShow, elements, verb, category, categoryInfo, dfi, ast, libraryVersions);
	}

	public dispose() {
		for(const d of this.disposables) {
			d.dispose();
		}
		this.refresher.dispose();
	}
}

interface DependenciesParams {
	readonly parent?:           Dependency;
	readonly verb:              string;
	readonly label:             string;
	readonly root?:             boolean;
	readonly children?:         Dependency[];
	readonly info?:             DependencyInfo;
	readonly allInfos:          DependencyInfo[];
	readonly collapsibleState?: vscode.TreeItemCollapsibleState;
	readonly icon?:             vscode.ThemeIcon;
	readonly locationMap?:      LocationMapQueryResult;
	readonly dfi?:              DataflowInformation;
	readonly ast?:              NormalizedAst;
	readonly category:          DependencyCategoryName;
	readonly categoryInfo:      DependencyCategoryInfo;
	readonly libraryVersions?:  Map<string, LibraryVersionInfo>;
	readonly tooltip?:          string;
}

export interface LibraryVersionInfo {
	/** the signature database's resolved version */
	db?:        string;
	/** the locally installed version; `null` when R was reachable but the package is not installed */
	installed?: string | null;
}

export class Dependency extends vscode.TreeItem {
	public readonly children?:     Dependency[];
	public readonly category:      DependencyCategoryName;
	private readonly info?:        DependencyInfo;
	private readonly loc?:         SourceRange;
	private parent?:               Dependency;
	private readonly locationMap?: LocationMapQueryResult;
	private readonly dfInfo?:      { dfi: DataflowInformation, ast: NormalizedAst };

	public setParent(parent: Dependency) {
		this.parent = parent;
		this.id = (parent.id ?? '') + this.id;
	}

	public getParent(): Dependency | undefined {
		return this.parent;
	}

	public getAnalysisInfo(): { dfi: DataflowInformation, ast: NormalizedAst } | undefined {
		return this.dfInfo;
	}

	constructor(
		{ label, root = false, children = [], info, icon, locationMap, collapsibleState, parent, verb, dfi, ast, category, categoryInfo, allInfos, libraryVersions, tooltip }: DependenciesParams
	) {
		collapsibleState ??= children.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
		super(label, collapsibleState);

		this.dfInfo = dfi && ast ? { dfi: dfi, ast } : undefined;
		this.children = children;
		this.info = info;
		this.parent = parent;
		this.locationMap = locationMap;
		this.category = category;
		this.iconPath = icon;

		if(info) {
			const functionName = renderFunctionName(info.functionName);
			this.loc = info.nodeId !== undefined ? locationMap?.map.ids[info.nodeId]?.[1] : undefined;

			// the signature database's resolved version and local installation state for a `library()`/`require()` dependency
			const versions = category === 'library' && info.value ? libraryVersions?.get(info.value) : undefined;
			const versionBadge = [
				versions?.db && `v${versions.db}`,
				versions?.installed === null ? 'not installed' : versions?.installed && `installed ${versions.installed}`
			].filter(Boolean).join(', ');
			// if the value is undefined or unknown, we already display the function name as the label (see unknownGuardedName)
			const known = info.value !== undefined && info.value !== Unknown;
			const folder = known && typeof info.value === 'string' ? shortenPath(info.value).folder : undefined;
			const pkg = known ? undefined : packageOf(info);
			this.description = `${folder ? `${folder}/ · ` : ''}${known ? `by "${functionName}" ` : pkg ? `from ${pkg} ` : ''}in ${this.loc ? `(L. ${this.loc[0]}${this.linkedIds()})` : 'unknown location'}${versionBadge ? ` — ${versionBadge}` : ''}`;
			this.tooltip = `${verb} "${info.value ?? Unknown}" with the "${functionName}" function in ${this.loc ? `line ${this.loc[0]}` : ' an unknown location'}${versions?.db ? ` (signature database: v${versions.db})` : ''}${versions?.installed === null ? ' (not installed locally)' : versions?.installed ? ` (installed locally: v${versions.installed})` : ''} (right-click for more)`;
			this.id = (parent?.id ?? '') + label + info.nodeId + JSON.stringify(this.loc) + functionName + this.linkedIds();
			if(this.loc && vscode.window.activeTextEditor) {
				// highlight the whole call, not only the function name the location map points at
				const span = (info.nodeId !== undefined ? RNode.span(ast?.idMap.get(info.nodeId)) : undefined) ?? this.loc;
				const start = new vscode.Position(span[0] - 1, span[1] - 1);
				const end = new vscode.Position(span[2] - 1, span[3]);
				this.command = {
					command:   RevealCommand,
					title:     'Go to and highlight the dependency',
					arguments: [{ uri: vscode.window.activeTextEditor.document.uri, range: new vscode.Range(start, end), category }]
				};
			}
		} else if(children.length > 0) {
			this.tooltip = `${typeof this.label === 'string' ? this.label : ''}${info ? ' (right-click for more!)' : ''}`;
			this.description = `${children.length} item${children.length === 1 ? '' : 's'}`;
			this.id = label + children.map(c => c.id).join('-');
		} else {
			this.description = '0 items';
			this.id = label;
		}
		if(tooltip) {
			this.tooltip = tooltip;
		}

		if(this.children.length === 0 && locationMap && info) {
			/* in the future we should be able to do better when flowR tells us the locations */
			const activeEditor = vscode.window.activeTextEditor;
			if(categoryInfo.useReverseLinks) {
				const dependents = allInfos.filter(i => i !== info && i.linkedIds && info.nodeId && i.linkedIds.includes(info.nodeId));
				if(dependents.length > 0) {
					this.children = makeGroupedElements(locationMap, dependents, allInfos, verb, category, categoryInfo, dfi, ast);
					this.children.flatMap(c => [c, ...c.children ?? []]).forEach(c => c.iconPath ??= new vscode.ThemeIcon('indent'));
					this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				}
			} else if(info.linkedIds) {
				this.children = info.linkedIds.toSorted((a, b) => compareByLocation(locationMap, a, b)).map(i => {
					const loc = locationMap.map.ids[i]?.[1];
					const tok = loc ? activeEditor?.document.getText(rangeToVscodeRange(loc)) : undefined;

					if(!tok) {
						return new Dependency({ label: `Linked to unknown location ${i}`, verb: 'is linked to', category, categoryInfo, allInfos });
					}
					return new Dependency({
						label:       tok ?? Unknown,
						verb:        'is linked to',
						locationMap: this.locationMap,
						info:        { nodeId: i, functionName: tok },
						parent:      this,
						icon:        new vscode.ThemeIcon('link'),
						category, categoryInfo, allInfos
					});
				});
				this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				this.iconPath = undefined;
			}
		}

		if(root) {
			this.contextValue = 'category';
			const enabled = getConfig().get<DependencyCategoryName[]>(Settings.DependenciesQueryEnabledCategories, Defaults.DependenciesQueryEnabledCategories);
			if(enabled.length > 0 && !enabled.includes(this.category)) {
				this.description = 'Disabled';
			}
		} else if(info) {
			this.contextValue = 'dependency';
			this.iconPath ??= new vscode.ThemeIcon('circle-small-filled', categoryColor(category));
		}
	}

	private linkedIds(): string {
		const num = this.info?.linkedIds?.length;
		return num ? `, linked to ${num} id` + (num === 1 ? '' : 's') : '';
	}

	enforceUniqueIds(seen: Set<string>) {
		if(seen.has(this.id ?? '')) {
			this.id = this.id + '-' + Math.random().toString(16).slice(2);
		}
		seen.add(this.id ?? '');
		this.children?.forEach(c => c.enforceUniqueIds(seen));
		return this;
	}

	getNodeId(): NodeId | undefined {
		return this.info?.nodeId;
	}

	getLocation(): SourceRange | undefined {
		return this.loc;
	}
}
function getActiveEditorCharLength() {
	return vscode.window.activeTextEditor?.document.getText().length ?? 0;
}

/** the theme color of a category, matching the line indicators next to the line numbers */
function categoryColor(category: string): vscode.ThemeColor | undefined {
	return category in dependencyDisplayInfo ? new vscode.ThemeColor(`vscodeFlowr.category.${category}`) : undefined;
}

/** Renders a dependency's {@link Identifier} function name as valid R (e.g. `purrr::map`, not `map,purrr,false`). */
export function renderFunctionName(fn: Identifier): string {
	try {
		return IdentifierUtil.toString(fn);
	} catch{
		// be robust against unexpected shapes rather than breaking the whole view
		return Array.isArray(fn) ? String(fn[0]) : String(fn);
	}
}

/** a dependency's display name: its `value` (rendered as `pkg::fn` when it is a namespaced Identifier), else the called function's name */
/** labels of the plots in the current view, see {@link describePlots} */
let plotLabels = new Map<DependencyInfo, string>();

/** the label of a dependency: its value, else its function (for a plot with its title or file) */
/** flowR reports the top-level `+` of a ggplot chain as an output to stdout, because R prints (draws) the plot it builds */
export function isImplicitPlotPrint(e: DependencyInfo): boolean {
	return e.value === 'stdout' && renderFunctionName(e.functionName) === '+';
}

/** the package a dependency's function comes from, if flowR knows it (`dplyr` for `dplyr::filter`) */
export function packageOf(e: DependencyInfo): string | undefined {
	try {
		return IdentifierUtil.getNamespace(e.functionName);
	} catch{
		return undefined;
	}
}

/**
 * A file path shortened for a narrow view: the label is the file name, shortened in the middle so that its start and its
 * suffix (e.g. the year and the extension) stay visible, and the folder goes to the description.
 */
export function shortenPath(path: string, max = 32): { label: string, folder?: string } {
	const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const name = at >= 0 && at < path.length - 1 ? path.slice(at + 1) : path;
	const folder = at > 0 && at < path.length - 1 ? path.slice(0, at) : undefined;
	if(name.length <= max) {
		return { label: name, folder };
	}
	const tail = Math.ceil((max - 1) / 2);
	return { label: `${name.slice(0, max - 1 - tail)}…${name.slice(-tail)}`, folder };
}

/** the label of a dependency entry: its plot description, value or function */
export function unknownGuardedName(e: DependencyInfo): string {
	if(isImplicitPlotPrint(e)) {
		return 'plot drawn (printed)';
	}
	const plot = plotLabels.get(e);
	if(plot) {
		return `${IdentifierUtil.getName(e.functionName)} ${plot}`;
	}
	const value = e.value as string | Identifier | undefined;
	if(value !== undefined && value !== Unknown) {
		// a namespaced call keeps its Identifier (e.g. purrr::map), which must be rendered, not stringified as an array
		return typeof value === 'string' ? value : renderFunctionName(value);
	}
	const named = IdentifierUtil.getName(e.functionName);
	return e.lexemeOfArgument ? `${named}: ${e.lexemeOfArgument}` : named;
}

const GrayedScheme = 'flowr-grayed';
const RevealCommand = 'vscode-flowr.internal.dependency.reveal';

let flash: vscode.TextEditorDecorationType | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** selects a dependency's code and briefly frames it in the color of its category */
async function revealDependency({ uri, range, category }: { uri: vscode.Uri, range: vscode.Range, category: DependencyCategoryName }) {
	const editor = await vscode.window.showTextDocument(uri, { preserveFocus: true });
	editor.selection = new vscode.Selection(range.start, range.end);
	editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	flash?.dispose();
	clearTimeout(flashTimer);
	flash = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
		border:          '1px solid',
		borderColor:     categoryColor(category),
		borderRadius:    '2px',
		isWholeLine:     false
	});
	editor.setDecorations(flash, [range]);
	flashTimer = setTimeout(() => flash?.dispose(), 2000);
}

/** the separator above the categories without findings */
function noFindingsSeparator(): Dependency {
	const separator = new Dependency({ label: 'No findings', verb: '', category: 'library', categoryInfo: dependencyDisplayInfo.library, allInfos: [] });
	separator.id = 'no-findings-separator';
	separator.description = '';
	separator.tooltip = 'Nothing found in this file, or disabled';
	separator.resourceUri = vscode.Uri.from({ scheme: GrayedScheme, path: '/separator' });
	return separator;
}

/** long paths are shortened to their (middle-shortened) file name, see {@link shortenPath} */
function displayLabel(e: DependencyInfo, name: string): string {
	return plotLabels.has(e) || typeof e.value !== 'string' || e.value === Unknown ? name : shortenPath(name).label;
}

const NoDataFlow = new Set<DependencyCategoryName>(['library', 'remote', 'source']);

/** adds the variables the data comes from and goes to: `filter(df) → small`, `data.csv → raw`, `small → out.csv` */
function withDataFlow(category: DependencyCategoryName, e: DependencyInfo, label: string, ast: NormalizedAst | undefined): string {
	if(NoDataFlow.has(category) || isImplicitPlotPrint(e) || plotLabels.has(e)) {
		return label;
	}
	const { input, output } = dataFlowOf(ast, e.nodeId);
	const value = typeof e.value === 'string' && e.value !== Unknown;
	if(value) {
		return `${input ? `${input} → ` : ''}${label}${output ? ` → ${output}` : ''}`;
	}
	const call = input ? `${label}(${input})` : label;
	return output ? `${call} → ${output}` : call;
}

function withNodeId(infos: DependencyInfo[]) {
	return infos.filter(info => isNotUndefined(info.nodeId)) as (DependencyInfo & Required<Pick<DependencyInfo, 'nodeId'>>)[];
}

function makeGroupedElements(locationMap: LocationMapQueryResult, elementsToShow: DependencyInfo[], allInfos: DependencyInfo[], verb: string, category: DependencyCategoryName, categoryInfo: DependencyCategoryInfo, dfi?: DataflowInformation, ast?: NormalizedAst, libraryVersions?: Map<string, LibraryVersionInfo>): Dependency[] {
	/* first group by name */
	const grouped = new Map<string, DependencyInfo[]>();
	for(const e of withNodeId(elementsToShow).toSorted((a, b) => compareByLocation(locationMap, a.nodeId, b.nodeId))) {
		const name = unknownGuardedName(e);
		if(!grouped.has(name)) {
			grouped.set(name, []);
		}
		grouped.get(name)?.push(e);
	}
	const flow = (e: DependencyInfo, label: string) => withDataFlow(category, e, label, ast);
	return Array.from(grouped.entries()).map(([name, group]) => {
		if(group.length === 1) {
			return new Dependency({ label: flow(group[0], displayLabel(group[0], name)), info: group[0], locationMap, verb, dfi, ast, category, categoryInfo, allInfos, libraryVersions });
		}
		const byValue = group[0].value !== undefined && group[0].value !== Unknown && !plotLabels.has(group[0]);
		const res = new Dependency({
			label:    displayLabel(group[0], name),
			verb,
			icon:     new vscode.ThemeIcon('folder', categoryColor(category)),
			tooltip:  name,
			children: group.map(e => new Dependency({
				verb,
				// the group already names the dataset or package, so its entries name how it is used
				label: flow(e, byValue ? renderFunctionName(e.functionName) : unknownGuardedName(e)),
				info:  e,
				dfi, ast, category, categoryInfo, allInfos, locationMap, libraryVersions
			})),
			dfi, ast, category, categoryInfo, allInfos, locationMap, libraryVersions
		});
		res.children?.forEach(c => c.setParent(res));
		return res;
	});
}

function compareByLocation(locationMap: LocationMapQueryResult, aNode: NodeId, bNode: NodeId): number {
	const a = locationMap?.map.ids[aNode]?.[1];
	const b = locationMap?.map.ids[bNode]?.[1];
	if(a && b) {
		return a[0] - b[0] || a[1] - b[1];
	} else if(a) {
		return -1;
	}
	return b ? 1 : 0;
}
