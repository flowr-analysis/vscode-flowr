import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from '../../extension';
import type { DefaultDependencyCategoryName , DependenciesQuery, DependenciesQueryResult, DependencyCategoryName, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import { DefaultDependencyCategories, Unknown } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { rangeToVscodeRange, RotaryBuffer } from '../utils';
import type { DefaultsMaps } from '../../settings';
import { DependencyViewRefresherConfigKeys, Settings , getConfig, isVerbose } from '../../settings';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import { ConfigurableRefresher, isRTypeLanguage, RefreshType } from '../../configurable-refresher';


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


export function registerDependencyInternalCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	registerCommand(context, 'vscode-flowr.internal.goto.dependency', (dependency: Dependency) => {
		const node = dependency.getNodeId();
		const loc = dependency.getLocation();
		if(node) {
			// got to position
			const editor = vscode.window.activeTextEditor;
			if(editor && loc) {
				setTimeout(() => {
					editor.revealRange(rangeToVscodeRange(loc), vscode.TextEditorRevealType.InCenter);
				}, 50);
			}
		}
	});
	registerCommand(context, 'vscode-flowr.internal.enable-disable.dependency', (dependency: Dependency) => {
		const values = new Set<DependencyCategoryName>(getConfig().get<DependencyCategoryName[]>(Settings.DependenciesQueryEnabledCategories, Defaults.DependenciesQueryEnabledCategories));
		if(!values.size) {
			// empty array means all are enabled, so we add them here to make the edit easier
			values.union(new Set<DependencyCategoryName>(Object.keys(DefaultDependencyCategories)));
		}
		if(values.has(dependency.category)) {
			values.delete(dependency.category);
		} else {
			values.add(dependency.category);
		}
		output.appendLine(`Toggling dependency category ${dependency.category}, new value ${[...values].join(', ')}`);
		getConfig().update(Settings.DependenciesQueryEnabledCategories, [...values]);
	});
}

/** returns disposer */
export function registerDependencyView(output: vscode.OutputChannel): { dispose: () => void, update: () => Promise<Dependency[] | undefined> } {
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
			data.dispose();
			disposeChange.dispose();
			disposeChangeActive.dispose();
			if(refreshDescDisposable) {
				refreshDescDisposable.dispose();
			}
		},
		update: async() =>{
			await data.refresh(true);
			return await data.getChildren() as Dependency[] | undefined;
		}
	};
}

const emptyDependencies: DependenciesQueryResult = { library: [], source: [], read: [], write: [], visualize: [], test: [], '.meta': { timing: -1 } } as unknown as DependenciesQueryResult;
const emptyLocationMap: LocationMapQueryResult = { map: {
	files: [],
	ids:   {}
}, '.meta': { timing: -1 } };
interface DependencyCategoryInfo {name: string, verb: string, icon: string, useReverseLinks?: boolean};
const dependencyDisplayInfo: Record<DefaultDependencyCategoryName, DependencyCategoryInfo> = {
	'library':   { name: 'Libraries', verb: 'loads the library', icon: 'library' },
	'read':      { name: 'Imported Data', verb: 'imports the data', icon: 'file-text' },
	'source':    { name: 'Sourced Scripts', verb: 'sources the script', icon: 'file-code' },
	'write':     { name: 'Outputs', verb: 'produces the output', icon: 'new-file' },
	'visualize': { name: 'Visualizations', verb: 'visualizes the data', icon: 'graph', useReverseLinks: true },
	'test':      { name: 'Tests', verb: 'tests for', icon: 'beaker' }
};
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

	async getDependenciesForActiveFile(): Promise<{ dep: DependenciesQueryResult, loc: LocationMapQueryResult, ast?: NormalizedAst, dfi?: DataflowInformation} | 'error'> {
		const activeEditor = vscode.window.activeTextEditor;
		if(!activeEditor) {
			return { dep: emptyDependencies, loc: emptyLocationMap };
		}
		const config = getConfig();
		const session = await getFlowrSession();
		const now = Date.now();
		const { result, hasError, dfi, ast } = await session.retrieveQuery(activeEditor.document, [
			{
				type:                   'dependencies',
				ignoreDefaultFunctions: config.get<boolean>(Settings.DependenciesQueryIgnoreDefaults, false),
				enabledCategories:      config.get<DependencyCategoryName[]>(Settings.DependenciesQueryEnabledCategories, Defaults.DependenciesQueryEnabledCategories),
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
				return { dep: result.dependencies, loc: result['location-map'], ast, dfi };
			} else {
				return 'error';
			}
		}
		this.output.appendLine(`[Dependency View] Refreshed in ${total}ms! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
		return { dep: result.dependencies, loc: result['location-map'], ast, dfi };
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
		if(!this.parent?.visible || !vscode.window.activeTextEditor || this.working || (!force && !isRTypeLanguage(vscode.window.activeTextEditor?.document))) {
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
			const has = !force && this.textBuffer.get(e => e?.[0].path === vscode.window.activeTextEditor?.document.uri.fsPath && e?.[0].content === text);
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
						if(getConfig().get<boolean>(Settings.DependencyViewKeepOnError, Defaults.DependencyViewKeepOnError)) {
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
					this.makeRootElements(res.dfi, res.ast);
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

	private makeRootElements(dfi?: DataflowInformation, ast?: NormalizedAst) {
		const uniqueIds = new Set<string>();
		this.rootElements = Object.entries(dependencyDisplayInfo).map(([d, i]) => {
			const result = this.activeDependencies[d] as DependencyInfo[];
			return this.makeDependency(i.name, i.verb, result, new vscode.ThemeIcon(i.icon), d, i, dfi, ast).enforceUniqueIds(uniqueIds);
		});
	}

	private makeDependency(label: string, verb: string, elements: DependencyInfo[], themeIcon: vscode.ThemeIcon, category: DependencyCategoryName, categoryInfo: DependencyCategoryInfo, dfi?: DataflowInformation, ast?: NormalizedAst): Dependency {
		const parent = new Dependency({ label, category, categoryInfo, icon: themeIcon, root: true, verb, children: this.makeChildren(elements, verb, category, categoryInfo, dfi, ast), ast, dfi, allInfos: elements });
		parent.children?.forEach(c => c.setParent(parent));
		return parent;
	}

	private makeChildren(elements: DependencyInfo[], verb: string, category: DependencyCategoryName, categoryInfo: DependencyCategoryInfo, dfi?: DataflowInformation, ast?: NormalizedAst): Dependency[] {
		// we exclude dependency infos that are already displayed through the useReverseLinks setting
		const elementsToShow = categoryInfo.useReverseLinks ? elements.filter(i => !i.linkedIds) : elements;
		return makeGroupedElements(this.locationMap, elementsToShow, elements, verb, category, categoryInfo, dfi, ast);
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
		{ label, root = false, children = [], info, icon, locationMap, collapsibleState, parent, verb, dfi, ast, category, categoryInfo, allInfos }: DependenciesParams
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
			this.loc = locationMap?.map.ids[info.nodeId]?.[1];
			// if the value is undefined or unknown, we already display the function name as the label (see unknownGuardedName)
			this.description = `${info.value && info.value !== Unknown ? `by "${info.functionName}" ` : ''}in ${this.loc ? `(L. ${this.loc[0]}${this.linkedIds()})` : 'unknown location'}`;
			this.tooltip = `${verb} "${info.value ?? Unknown}" with the "${info.functionName}" function in ${this.loc ? `line ${this.loc[0]}` : ' an unknown location'} (right-click for more)`;
			this.id = (parent?.id ?? '') + label + info.nodeId + JSON.stringify(this.loc) + info.functionName + this.linkedIds();
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

		if(this.children.length === 0 && locationMap && info) {
			/* in the future we should be able to do better when flowR tells us the locations */
			const activeEditor = vscode.window.activeTextEditor;
			if(categoryInfo.useReverseLinks) {
				const dependents = allInfos.filter(i => i !== info && i.linkedIds && i.linkedIds.indexOf(info.nodeId) >= 0);
				if(dependents.length > 0){
					this.children = makeGroupedElements(locationMap, dependents, allInfos, verb, category, categoryInfo, dfi, ast);
					this.children.flatMap(c => [c, ...c.children ?? []]).forEach(c => c.iconPath ??= new vscode.ThemeIcon('indent'));
					this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				}
			} else if(info.linkedIds){
				this.children = info.linkedIds.toSorted((a,b) => compareByLocation(locationMap, a, b)).map(i => {
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

		if(root){
			this.contextValue = 'category';
			if(getConfig().get<DependencyCategoryName[]>(Settings.DependenciesQueryEnabledCategories, Defaults.DependenciesQueryEnabledCategories).findIndex(c => this.category === c) < 0) {
				this.description = 'Disabled';
			}		
		} else if(info) {
			this.contextValue = 'dependency';
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

function unknownGuardedName(e: DependencyInfo): string {
	let value = e.value ?? Unknown;
	if(value === Unknown){
		value = `function "${e.functionName}"`;
		if(e.lexemeOfArgument) {
			value = `${value}: ${e.lexemeOfArgument}`;
		}
	}
	return value;
};

function makeGroupedElements(locationMap: LocationMapQueryResult, elementsToShow: DependencyInfo[], allInfos: DependencyInfo[], verb: string, category: DependencyCategoryName, categoryInfo: DependencyCategoryInfo, dfi?: DataflowInformation, ast?: NormalizedAst): Dependency[] {
	/* first group by name */
	const grouped = new Map<string, DependencyInfo[]>();
	for(const e of elementsToShow.toSorted((a,b) => compareByLocation(locationMap, a.nodeId, b.nodeId))) {
		const name = unknownGuardedName(e) + (e.value && e.value !== Unknown ? ` (${e.functionName})` : '');
		if(!grouped.has(name)) {
			grouped.set(name, []);
		}
		grouped.get(name)?.push(e);
	}
	return Array.from(grouped.entries()).map(([name, group]) => {
		if(group.length === 1) {
			return new Dependency({ label: unknownGuardedName(group[0]), info: group[0], locationMap, verb, dfi, ast, category, categoryInfo, allInfos });
		}
		const res = new Dependency({
			label:    name,
			verb,
			icon:     vscode.ThemeIcon.Folder,
			children: group.map(e => new Dependency({
				verb,
				label: unknownGuardedName(e),
				info:  e,
				dfi, ast, category, categoryInfo, allInfos, locationMap
			})),
			dfi, ast, category, categoryInfo, allInfos, locationMap
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
