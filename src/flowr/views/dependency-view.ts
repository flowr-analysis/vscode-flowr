import * as vscode from 'vscode';
import { getConfig, getFlowrSession, isVerbose } from '../../extension';
import type { DependenciesQuery, DependenciesQueryResult, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { RotaryBuffer } from '../utils';
import { Settings } from '../../settings';
import type { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';

const FlowrDependencyViewId = 'flowr-dependencies';
/** returns disposer */
export function registerDependencyView(output: vscode.OutputChannel): { dispose: () => void, update: () => void } {
	const data = new FlowrDependencyTreeView(output);
	const tv = vscode.window.createTreeView(
		FlowrDependencyViewId,
		{
			treeDataProvider: data
		}
	);

	let refreshDescDisposable: vscode.Disposable | undefined;

	function refreshDesc() {
		let message: string;
		if(vscode.window.activeTextEditor?.document.languageId !== 'r') {
			message = 'In an R script, this view ';
		} else {
			message = 'This view ';
		}
		if(refreshDescDisposable) {
			refreshDescDisposable.dispose();
			refreshDescDisposable = undefined;
		}
		switch(getConfig().get<string>(Settings.DependencyViewUpdateType, 'adaptive')) {
			case 'interval': {
				const secs = getConfig().get<number>(Settings.DependencyViewUpdateInterval, 10);
				message += `updates every ${secs} second${secs === 1 ? '' : 's'}`;
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(Settings.DependencyViewAdaptiveBreak, 5000);
				if(getActiveEditorCharLength() > breakOff) {
					const secs = getConfig().get<number>(Settings.DependencyViewUpdateInterval, 10);
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
	const disposeChange = vscode.workspace.onDidChangeConfiguration(() => {
		refreshDesc();
	});
	const disposeChangeActive = vscode.window.onDidChangeActiveTextEditor(() => {
		refreshDesc();
	});


	data.setTreeView(tv);
	return {
		dispose: () => {
			data.dispose();
			disposeChange.dispose();
			disposeChangeActive.dispose();
			if(refreshDescDisposable) {
				refreshDescDisposable.dispose();
			}
		},
		update: () => void data.refresh(true)
	};
}

const emptyDependencies: DependenciesQueryResult = { libraries: [], readData: [], sourcedFiles: [], writtenData: [], '.meta': { timing: -1 } };
const emptyLocationMap: LocationMapQueryResult = { map: {
	files: [],
	ids:   {}
}, '.meta': { timing: -1 } };
type Update = Dependency | undefined | null
class FlowrDependencyTreeView implements vscode.TreeDataProvider<Dependency> {
	private readonly output:               vscode.OutputChannel;
	private activeDependencies:            DependenciesQueryResult = emptyDependencies;
	private locationMap:                   LocationMapQueryResult = emptyLocationMap;
	private readonly _onDidChangeTreeData: vscode.EventEmitter<Update> = new vscode.EventEmitter<Update>();
	readonly onDidChangeTreeData:          vscode.Event<Update> = this._onDidChangeTreeData.event;
	private disposables:                   vscode.Disposable[] = [];
	private parent:                        vscode.TreeView<Dependency> | undefined;
	private rootElements:                  Dependency[] | undefined;

	constructor(output: vscode.OutputChannel) {
		this.output = output;


		this.updateConfig();
		// trigger if config changes:
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(async changed => {
			if(!changed.affectsConfiguration(Settings.Category)) {
				return;
			}
			this.updateConfig();
			await this.refresh();
		}));
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(async e => {
			if(e?.document.languageId === 'r') {
				await this.refresh();
			}
		}));

		/* lazy startup patches */
		setTimeout(() => void this.refresh(), 500);
	}

	private activeInterval:   NodeJS.Timeout | undefined;
	private activeDisposable: vscode.Disposable | undefined;
	private updateConfig() {
		this.output.appendLine('[Dependency View] Updating configuration!');
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
			this.activeInterval = undefined;
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
			this.activeDisposable = undefined;
		}
		switch(getConfig().get<string>(Settings.DependencyViewUpdateType, 'never')) {
			case 'never': break;
			case 'interval': {
				this.activeInterval = setInterval(() => void this.refresh(), getConfig().get<number>(Settings.DependencyViewUpdateInterval, 10) * 1000);
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(Settings.DependencyViewAdaptiveBreak, 5000);
				if(getActiveEditorCharLength() > breakOff) {
					this.activeInterval = setInterval(() => void this.refresh(), getConfig().get<number>(Settings.DependencyViewUpdateInterval, 10) * 1000);
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() <= breakOff) {
							this.updateConfig();
						}
					});
				} else {
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(async e => {
						if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor?.document.languageId === 'r') {
							if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
								if(isVerbose()) {
									this.output.appendLine('Skip update because event version: ' + e.document.version + 'is less than that of the active document: ' + (vscode.window.activeTextEditor?.document.version ?? 0) + ' (there is a newer version!).');
								}
								return;
							}
							await this.refresh();
						}
						if(getActiveEditorCharLength() > breakOff) {
							this.updateConfig();
						}
					});
				}
				break;
			}
			case 'on save':
				this.activeDisposable = vscode.workspace.onWillSaveTextDocument(async() => await this.refresh());
				break;
			case 'on change':
				this.activeDisposable = vscode.workspace.onDidChangeTextDocument(async e => {
					if(e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor?.document.languageId === 'r') {
						if(e.document.version < (vscode.window.activeTextEditor?.document.version ?? 0)) {
							if(isVerbose()) {
								this.output.appendLine('Skip update because event version: ' + e.document.version + 'is less than that of the active document: ' + (vscode.window.activeTextEditor?.document.version ?? 0) + ' (there is a newer version!).');
							}
							return;
						}
						await this.refresh();
					}
				});
				break;
			default:
				this.output.appendLine(`[Dependency View] Invalid update type: ${getConfig().get<string>(Settings.DependencyViewUpdateType)}`);
		}
		const configuredBufSize = getConfig().get<number>(Settings.DependencyViewCacheLimit, 3);
		if(this.textBuffer.size() !== configuredBufSize) {
			this.textBuffer = new RotaryBuffer(configuredBufSize);
		}
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

	async getDependenciesForActiveFile(): Promise<{ dep: DependenciesQueryResult, loc: LocationMapQueryResult, ast?: NormalizedAst, dfg?: DataflowGraph} | 'error'> {
		const activeEditor = vscode.window.activeTextEditor;
		if(!activeEditor) {
			return { dep: emptyDependencies, loc: emptyLocationMap };
		}
		const config = getConfig();
		const session = await getFlowrSession();
		const now = Date.now();
		const { result, hasError, dfg, ast } = await session.retrieveQuery(activeEditor.document, [
			{
				type:                   'dependencies',
				ignoreDefaultFunctions: config.get<boolean>(Settings.DependenciesQueryIgnoreDefaults, false),
				...config.get<Omit<DependenciesQuery, 'type' | 'ignoreDefaultFunctions'>>(Settings.DependenciesQueryOverrides)
			},
			{
				type: 'location-map'
			}
		]);
		const total = Date.now() - now;
		if(hasError) {
			this.output.appendLine('[Dependency View] Error: Could not retrieve dependencies (parser error)');
			if(result.dependencies && result['location-map']) {
				this.output.appendLine(`[Dependency View] Refreshed (partially) in ${total}ms! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
				return { dep: result.dependencies, loc: result['location-map'], ast, dfg };
			} else {
				return 'error';
			}
		}
		this.output.appendLine(`[Dependency View] Refreshed in ${total}ms! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
		return { dep: result.dependencies, loc: result['location-map'], ast, dfg };
	}

	private working = false;
	private textBuffer: RotaryBuffer<[{ content: string, path: string }, { dep: DependenciesQueryResult, loc: LocationMapQueryResult}]> = new RotaryBuffer(0);
	private lastText = '';
	private lastFile = '';

	private textFingerprint(text: string): string {
		return text.trim().replace(/[ \t]+$|^[ \t]*#.*$/gm, '');
	}

	public async refresh(force = false) {
		if(this.working && force) {
			this.working = false;
		}
		if(!this.parent?.visible || !vscode.window.activeTextEditor || this.working || (!force && vscode.window.activeTextEditor?.document.languageId !== 'r')) {
			if(force) {
				this.output.appendLine('[Dependency View] Do not force refresh (visible: ' + this.parent?.visible + ', working: ' + this.working + ', language: ' + vscode.window.activeTextEditor?.document.languageId + ')');
			} else if(isVerbose()) {
				this.output.appendLine('[Dependency View] Do not refresh (visible: ' + this.parent?.visible + ', working: ' + this.working + ', language: ' + vscode.window.activeTextEditor?.document.languageId + ')');
			}
			return;
		}
		const text = this.textFingerprint(vscode.window.activeTextEditor?.document.getText());
		const file = vscode.window.activeTextEditor?.document.uri.fsPath;
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
		try {
			const has = this.textBuffer.get(e => e?.[0].path === vscode.window.activeTextEditor?.document.uri.fsPath && e?.[0].content === text);
			if(has) {
				try {
					this.output.appendLine(`[Dependency View] Using cached dependencies (Dependencies: ${has[1].dep['.meta'].timing}ms, Locations: ${has[1].loc['.meta'].timing}ms)`);
				} catch(e) {
					this.output.appendLine(`[Dependency View] Error: ${(e as Error).message}`);
					this.output.appendLine((e as Error).stack ?? '');
				}
				this.activeDependencies = has[1].dep;
				this.locationMap = has[1].loc;
				this.makeRootElements();
				this._onDidChangeTreeData.fire(undefined);
				return;
			}
			await vscode.window.withProgress({ location: { viewId: FlowrDependencyViewId } }, () => {
				return this.getDependenciesForActiveFile().then(res => {
					if(res === 'error') {
						if(getConfig().get<boolean>(Settings.DependencyViewKeepOnError, true)) {
							return;
						} else {
							this.activeDependencies = emptyDependencies;
							this.locationMap = emptyLocationMap;
							this.makeRootElements();
							this._onDidChangeTreeData.fire(undefined);
							return;
						}
					}
					this.activeDependencies = res.dep;
					this.locationMap = res.loc;
					this.textBuffer.push([{ content: text, path: vscode.window.activeTextEditor?.document.uri.fsPath ?? '' }, res]);
					this.makeRootElements(res.dfg, res.ast);
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
		const autoRevealUntil = getConfig().get<number>(Settings.DependencyViewAutoReveal, 5);
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

	private makeRootElements(dfg?: DataflowGraph, ast?: NormalizedAst) {
		this.rootElements = [
			this.makeDependency('Libraries', 'loads the library', this.activeDependencies.libraries, new vscode.ThemeIcon('library'), e => e.libraryName, dfg, ast),
			this.makeDependency('Imported Data', 'imports the data', this.activeDependencies.readData, new vscode.ThemeIcon('file-text'), e => e.source, dfg, ast),
			this.makeDependency('Sourced Scripts', 'sources the script', this.activeDependencies.sourcedFiles, new vscode.ThemeIcon('file-code'), e => e.file, dfg, ast),
			this.makeDependency('Outputs', 'produces the output', this.activeDependencies.writtenData, new vscode.ThemeIcon('new-file'), e => e.destination, dfg, ast)
		];
	}

	private makeDependency<E extends DependencyInfo>(label: string, verb: string, elements: E[], themeIcon: vscode.ThemeIcon, getName: (e: E) => string, dfg?: DataflowGraph, ast?: NormalizedAst): Dependency {
		const parent = new Dependency({ label, icon: themeIcon, root: true, verb, children: this.makeChildren(getName, elements, verb, dfg, ast), ast, graph: dfg });
		parent.children?.forEach(c => c.setParent(parent));
		return parent;
	}

	private makeChildren<E extends DependencyInfo>(getName: (e: E) => string, elements: E[], verb: string, dfg?: DataflowGraph, ast?: NormalizedAst): Dependency[] {
		const unknownGuardedName = (e: E) => {
			const name = getName(e);
			if(name === 'unknown' && e.lexemeOfArgument) {
				return name + ': ' + e.lexemeOfArgument;
			}
			return name;
		};
		/* first group by name */
		const grouped = new Map<string, E[]>();
		for(const e of elements) {
			const name = getName(e) + ' (' + e.functionName + ')';
			if(!grouped.has(name)) {
				grouped.set(name, []);
			}
			grouped.get(name)?.push(e);
		}
		return Array.from(grouped.entries()).map(([name, elements]) => {
			if(elements.length === 1) {
				return new Dependency({ label: unknownGuardedName(elements[0]), info: elements[0], locationMap: this.locationMap, verb, graph: dfg, ast });
			}
			const res = new Dependency({
				label:       name,
				locationMap: this.locationMap,
				verb,
				icon:        vscode.ThemeIcon.Folder,
				children:    elements.map(e => new Dependency({
					verb,
					label:       unknownGuardedName(e),
					info:        e,
					locationMap: this.locationMap,
					graph:       dfg,
					ast
				})),
				graph: dfg,
				ast
			});
			res.children?.forEach(c => c.setParent(res));
			return res;
		});
	}

	public dispose() {
		for(const d of this.disposables) {
			d.dispose();
		}
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
		}
	}
}

interface DependenciesParams {
	readonly parent?:             Dependency;
	readonly verb:                string;
   readonly label:             string;
   readonly root?:             boolean;
   readonly children?:         Dependency[];
   readonly info?:             DependencyInfo;
   readonly collapsibleState?: vscode.TreeItemCollapsibleState;
   readonly icon?:             vscode.ThemeIcon;
   readonly locationMap?:      LocationMapQueryResult;
	readonly graph?:              DataflowGraph;
	readonly ast?:                NormalizedAst;
}

export class Dependency extends vscode.TreeItem {
	public readonly children?:     Dependency[];
	private readonly info?:        DependencyInfo;
	private readonly loc?:         SourceRange;
	private parent?:               Dependency;
	private readonly locationMap?: LocationMapQueryResult;
	private readonly dfInfo?:      { graph: DataflowGraph, ast: NormalizedAst };

	public setParent(parent: Dependency) {
		this.parent = parent;
	}

	public getParent(): Dependency | undefined {
		return this.parent;
	}

	public getAnalysisInfo(): { graph: DataflowGraph, ast: NormalizedAst } | undefined {
		return this.dfInfo;
	}

	constructor(
		{ label, root = false, children = [], info, icon, locationMap, collapsibleState, parent, verb, graph, ast }: DependenciesParams
	) {
		collapsibleState ??= children.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
		super(label, collapsibleState);

		this.dfInfo = graph && ast ? { graph, ast } : undefined;
		this.children = children;
		this.info = info;
		this.parent = parent;
		this.locationMap = locationMap;

		if(info) {
			this.loc = locationMap?.map.ids[info.nodeId]?.[1];
			this.description = `by ${info.functionName} in ${this.loc ? `(L. ${this.loc[0]}${this.linkedIds()})` : 'unknown location'}`;
			this.tooltip = `${verb} ${JSON.stringify(this.label)} with the "${info.functionName}" function in ${this.loc ? `line ${this.loc[0]}` : ' an unknown location'} (right-click for more)`;
			this.id = label + info.nodeId + JSON.stringify(this.loc) + info.functionName + this.linkedIds();
			if(this.loc && vscode.window.activeTextEditor) {
				const start = new vscode.Position(this.loc[0] - 1, this.loc[1] - 1);
				const end = new vscode.Position(this.loc[2] - 1, this.loc[3]);
				this.command = {
					/* simply move cursor to location */
					command:   'editor.action.goToLocations',
					title:     'go to location',
					arguments: [
						vscode.window.activeTextEditor.document.uri, // anchor uri and position
						start,
						[new vscode.Location(vscode.window.activeTextEditor.document.uri, new vscode.Range(start, end))], // locations
						'goto'
					]
				};
			}
		} else if(children.length > 0) {
			this.tooltip = `${typeof this.label === 'string' ? this.label : ''}${info ? ' (right-click for more!)' : ''}`;
			this.description =`${children.length} item${children.length === 1 ? '' : 's'}`;
			this.id = label + children.map(c => c.id).join('-');
		} else {
			this.description = '0 items';
			this.id = label;
		}

		if(this.children.length === 0 && locationMap && this.info?.linkedIds) {
			/* in the future we should be able to do better when flowR tells us the locations */

			const activeEditor = vscode.window.activeTextEditor;
			this.children = this.info.linkedIds.map(i => {
				const loc = locationMap.map.ids[i]?.[1];
				const tok = loc ? activeEditor?.document.getText(new vscode.Range(loc[0] - 1, loc[1] - 1, loc[2] - 1, loc[3])) : undefined;

				if(!tok) {
					return new Dependency({ label: `Linked to unknown location ${i}`, verb: 'is linked to' });
				}
				return new Dependency({
					label:       'unknown',
					verb:        'is linked to',
					locationMap: this.locationMap,
					info:        { nodeId: i, functionName: tok },
					parent:      this,
					icon:        new vscode.ThemeIcon('link')
				});
			});
			this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		} else if(icon) {
			this.iconPath = icon;
		}
		if(!root && info) {
			this.contextValue = 'dependency';
		}
	}

	private linkedIds(): string {
		const num = this.info?.linkedIds?.length;
		return num ? `, linked to ${num} id` + (num === 1 ? '' : 's') : '';
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

