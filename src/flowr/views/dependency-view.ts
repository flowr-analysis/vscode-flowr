import * as vscode from 'vscode';
import { getFlowrSession } from '../../extension';
import type { DependenciesQueryResult, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { RotaryBuffer } from '../utils';

const FlowrDependencyViewId = 'flowr-dependencies';
/** returns disposer */
export function registerDependencyView(output: vscode.OutputChannel): () => void {
	const data = new FlowrDependencyTreeView(output);
	vscode.window.createTreeView(
		FlowrDependencyViewId,
		{
			treeDataProvider: data
		}
	);
	return () => data.dispose();
}
   
const emptyDependencies: DependenciesQueryResult = { libraries: [], readData: [], sourcedFiles: [], writtenData: [], '.meta': { timing: -1 } };
const emptyLocationMap: LocationMapQueryResult = { map: {}, '.meta': { timing: -1 } };
type Update = Dependency | undefined | null
class FlowrDependencyTreeView implements vscode.TreeDataProvider<Dependency> {
	private readonly output:               vscode.OutputChannel;
	private activeDependencies:            DependenciesQueryResult = emptyDependencies;
	private locationMap:                   LocationMapQueryResult = emptyLocationMap;
	private readonly _onDidChangeTreeData: vscode.EventEmitter<Update> = new vscode.EventEmitter<Update>();
	readonly onDidChangeTreeData:          vscode.Event<Update> = this._onDidChangeTreeData.event;
	private disposables:                   vscode.Disposable[] = [];
   
	constructor(output: vscode.OutputChannel) {
		this.output = output;
      
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(async() => await this.refresh()));
		this.disposables.push(vscode.workspace.onWillSaveTextDocument(async() => await this.refresh()));
   
		/* lazy startup patches */
		setTimeout(() => void this.refresh(), 500);
		setTimeout(() => void this.refresh(), 2000);
		setInterval(() => void this.refresh(), 10000);
	}
   
	async getDependenciesForActiveFile(): Promise<{ dep: DependenciesQueryResult, loc: LocationMapQueryResult}> {
		const activeEditor = vscode.window.activeTextEditor;
		if(!activeEditor) {
			return { dep: emptyDependencies, loc: emptyLocationMap };
		}
		const session = await getFlowrSession();
		const result = await session.retrieveQuery(activeEditor.document, [{ type: 'dependencies' }, { type: 'location-map' }]);
		this.output.appendLine(`[Dependencies View] Refreshed! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
		return { dep: result.dependencies, loc: result['location-map'] };
	} 
   
	private working = false;
	private readonly textBuffer = new RotaryBuffer<[string, { dep: DependenciesQueryResult, loc: LocationMapQueryResult}]>(5);
	private lastText = '';
	
	private textFingerprint(text: string): string {
		return text.trim().replace(/\s|^\s*#.*$/gm, '');
	}
	
	private async refresh() {
		if(this.working) {
			return;
		}
		if(vscode.window.activeTextEditor?.document.languageId !== 'r') {
			return;
		}
		const text = this.textFingerprint(vscode.window.activeTextEditor?.document.getText());
		if(text === this.lastText) {
			return;
		} else {
			this.lastText = text ?? '';
		}
		this.output.appendLine('Refreshing dependencies');
		this.working = true;
		try {
			const has = this.textBuffer.get(e => e?.[0] === text);
			if(has) {
				this.output.appendLine(`[Dependencies View] Using cached dependencies (Dependencies: ${has[1].dep['.meta'].timing}ms, Locations: ${has[1].loc['.meta'].timing}ms)`);
				this.activeDependencies = has[1].dep;
				this.locationMap = has[1].loc;
				this._onDidChangeTreeData.fire(undefined);
				return;
			}
			await vscode.window.withProgress({ location: { viewId: FlowrDependencyViewId } }, () => {
				return this.getDependenciesForActiveFile().then(res => {
					this.activeDependencies = res.dep;
					this.locationMap = res.loc;
					this.textBuffer.push([text, res]);
					this._onDidChangeTreeData.fire(undefined);
				}).catch(e => {
					this.output.appendLine(`[Dependencies View] Error: ${e}`);
				});
			});
		} catch(e) {
			this.output.appendLine('[Dependencies View] Error: Could not refresh dependencies');
			this.output.appendLine((e as Error).message);
			this.output.appendLine((e as Error).stack ?? '');
		} finally {
			this.working = false;
		}
	}

	getTreeItem(element: Dependency): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}
   
	getChildren(element?: Dependency): vscode.ProviderResult<Dependency[]> {
		if(element) {
			return element.children ?? [];
		} else {
			return [
				new Dependency({ label: 'Libraries',     icon: new vscode.ThemeIcon('library'), root: true, children: this.makeChildren(e => e.libraryName, this.activeDependencies.libraries) }),
				new Dependency({ label: 'Imported Data',     icon: new vscode.ThemeIcon('file-text'),    root: true, children: this.makeChildren(e => e.source, this.activeDependencies.readData) }),
				new Dependency({ label: 'Sourced Scripts', icon: new vscode.ThemeIcon('file-code'),  root: true, children: this.makeChildren(e => e.file, this.activeDependencies.sourcedFiles) }),
				new Dependency({ label: 'Outputs',  icon: new vscode.ThemeIcon('new-file'),   root: true, children: this.makeChildren(e => e.destination, this.activeDependencies.writtenData) })
			];
		}
	}
   
	private makeChildren<E extends DependencyInfo>(getName: (e: E) => string, elements: E[]): Dependency[] {
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
				return new Dependency({ label: getName(elements[0]), info: elements[0], locationMap: this.locationMap });
			}
			return new Dependency({ label:       name, locationMap: this.locationMap, children:    elements.map(e => new Dependency({
				label:       getName(e), 
				info:        e, 
				locationMap: this.locationMap
			})) 
			});
		});
	}
   
	public dispose() {
		for(const d of this.disposables) {
			d.dispose();
		}
	}
}

interface DependenciesParams {
   readonly label:             string;
   readonly root?:             boolean;
   readonly children?:         Dependency[];
   readonly info?:             DependencyInfo;
   readonly collapsibleState?: vscode.TreeItemCollapsibleState;
   readonly icon?:             vscode.ThemeIcon;
   readonly locationMap?:      LocationMapQueryResult;
}

export class Dependency extends vscode.TreeItem {
	public readonly children?: Dependency[];
	private readonly info?:    DependencyInfo;
	private readonly loc?:     SourceRange;
	constructor(
		{ label, root = false, children = [], info, icon: media, locationMap, collapsibleState }: DependenciesParams
	) {
		if(children.length === 0) {
			collapsibleState = vscode.TreeItemCollapsibleState.None;
		} else {
			collapsibleState = children.length < 10 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
		}
		super(label, collapsibleState);
		this.children = children;
		this.info = info;
     
		if(info) {
			this.loc = locationMap?.map[info.nodeId];
			this.description = `${info.functionName} in ${this.loc ? `(L. ${this.loc[0]})` : 'unknown location'}`;
			this.tooltip = `${info.functionName} in ${this.loc ? `Line ${this.loc[0]}` : 'unknown location'}`;
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
		} else {
			this.description =`${children.length} item${children.length === 1 ? '' : 's'}`;
		}
 
		if(root) {
			this.iconPath = media;
		} else if(info) {
			this.contextValue = 'dependency';
		}
	}
    
	getNodeId(): NodeId | undefined {
		return this.info?.nodeId;
	}
 
	getLocation(): SourceRange | undefined {
		return this.loc;
	}
}