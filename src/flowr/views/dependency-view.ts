import path from "path";
import { FlowrSession } from "../utils";
import * as vscode from 'vscode';
import { getFlowrSession } from "../../extension";
import { DependenciesQuery, DependenciesQueryResult, DependencyInfo } from "@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format";
import { publicDecrypt } from "crypto";
import { LocationMapQueryResult } from "@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format";

const FlowrDependencyViewId = 'flowr-dependencies';
export function registerDependencyView(output: vscode.OutputChannel) {
   const viewContainer = vscode.window.createTreeView(
      FlowrDependencyViewId,
      {
         treeDataProvider: new FlowrDependencyTreeView(output),
      }
   )
}
   
// TODO: button to gernreate dependency report
// TODO: go to library docs?
const emptyDependencies: DependenciesQueryResult = { libraries: [], readData: [], sourcedFiles: [], writtenData: [], ".meta": { timing: -1 } };
const emptyLocationMap: LocationMapQueryResult = { map: {}, ".meta": { timing: -1 } };
type Update = Dependency | undefined | null | void
class FlowrDependencyTreeView implements vscode.TreeDataProvider<Dependency> {
   private readonly output: vscode.OutputChannel;
   private activeDependencies: DependenciesQueryResult = emptyDependencies;
   private locationMap: LocationMapQueryResult = emptyLocationMap;
   private readonly _onDidChangeTreeData: vscode.EventEmitter<Update> = new vscode.EventEmitter<Update>();
   readonly onDidChangeTreeData: vscode.Event<Update> = this._onDidChangeTreeData.event;
   
   constructor(output: vscode.OutputChannel) {
      this.output = output;
      
      vscode.window.onDidChangeActiveTextEditor(async () => this.refresh());
      vscode.workspace.onDidChangeTextDocument(async () => this.refresh());
      
      /* lazy startup patches */
      setTimeout(async () => await this.refresh(), 500);
      setTimeout(async () => await this.refresh(), 1000);
      setInterval(async () => await this.refresh(), 10000);
   
   }
   
   private lastText = '';
   async getDependenciesForActiveFile(): Promise<{ dep: DependenciesQueryResult, loc: LocationMapQueryResult}> {
      const activeEditor = vscode.window.activeTextEditor;
      if(!activeEditor) {
         return { dep: emptyDependencies, loc: emptyLocationMap };
      }
      if(activeEditor.document.getText().trim() === this.lastText) {
         return { dep: this.activeDependencies, loc: this.locationMap };
      } else {
         this.lastText = activeEditor.document.getText().trim();
      }
      const session = await getFlowrSession();
      const result = await session.retrieveQuery(activeEditor.document, [{ type: 'dependencies' }, { type: 'location-map' }]);
      return { dep: result.dependencies, loc: result['location-map'] };
   } 
   
   private lastRefresh = 0;
   private async refresh() {
      if(Date.now() - this.lastRefresh < 1000) {
         return;
      }
      await vscode.window.withProgress({ location: { viewId: "customView" } }, () => {
         return this.getDependenciesForActiveFile().then(res => {
            this.activeDependencies = res.dep;
            this.locationMap = res.loc;
            this._onDidChangeTreeData.fire(undefined);
         })
      })
   }

   getTreeItem(element: Dependency): vscode.TreeItem | Thenable<vscode.TreeItem> {
      return element;
   }
   
   getChildren(element?: Dependency): vscode.ProviderResult<Dependency[]> {
      if (element) {
         return element.children ?? [];
      } else {
         return [
            // TODO: handle unknown
            new Dependency({ label: 'Libraries',     media: 'library.svg', root: true, children: this.makeChildren(e => e.libraryName, this.activeDependencies.libraries) }),
            new Dependency({ label: 'Read Data',     media: 'read.svg',    root: true, children: this.makeChildren(e => e.source, this.activeDependencies.readData) }),
            new Dependency({ label: 'Sourced Files', media: 'source.svg',  root: true, children: this.makeChildren(e => e.file, this.activeDependencies.sourcedFiles) }),
            new Dependency({ label: 'Written Data',  media: 'write.svg',   root: true, children: this.makeChildren(e => e.destination, this.activeDependencies.writtenData) })
         ]
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
         grouped.get(name)!.push(e);
      }
      return Array.from(grouped.entries()).map(([name, elements]) => {
         if(elements.length === 1) {
            return new Dependency({ label: getName(elements[0]), info: elements[0], locationMap: this.locationMap });
         }
         return new Dependency({ label: name, locationMap: this.locationMap, children: elements.map(e => new Dependency({
                  label: getName(e), 
                  info: e, 
                  locationMap: this.locationMap
            })) 
         });
      })
   }
}

interface DependenciesParams {
   readonly label: string;
   readonly root?: boolean;
   readonly children?: Dependency[];
   readonly info?: DependencyInfo;
   readonly collapsibleState?: vscode.TreeItemCollapsibleState;
   readonly media?: string;
   readonly locationMap?: LocationMapQueryResult;
}

class Dependency extends vscode.TreeItem {
   public readonly children?: Dependency[];
   // TODO: to interface
   constructor(
      { label, root = false, children = [], info, media = 'dependency.svg', locationMap, collapsibleState}: DependenciesParams
   ) {
      if(children.length === 0) {
         collapsibleState = vscode.TreeItemCollapsibleState.None;
      } else {
         collapsibleState = children.length < 10 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      }
     super(label, collapsibleState);
     this.children = children;
     
     if(info) {
         const loc = locationMap?.map[info.nodeId];
         this.description = `${info.functionName} in ${loc ? `(L. ${loc[0]})` : 'unknown location'}`;
         this.tooltip = `${info.functionName} in ${loc ? `Line ${loc[0]}` : 'unknown location'}`;
         if(loc && vscode.window.activeTextEditor) {
            const start = new vscode.Position(loc[0] - 1, loc[1] - 1);
            const end = new vscode.Position(loc[2] - 1, loc[3]);
            this.command = {
               /* simply move cursor to location */
               command: 'editor.action.goToLocations',
               title: 'go to location',
               arguments: [
                  vscode.window.activeTextEditor.document.uri, // anchor uri and position
                  start,
                  [new vscode.Location(vscode.window.activeTextEditor.document.uri, new vscode.Range(start, end))], // locations
                  'goto'
               ]
            }
         }
     } else if(children.length > 0) {
         this.tooltip = `${this.label}`; 
         this.description =`${children.length} item${children.length === 1 ? '' : 's'}`;
      } else {
      this.description =`${children.length} item${children.length === 1 ? '' : 's'}`;
   }
 
   if(root) {
      this.iconPath = {
      light: path.join(__dirname, '..', '..', '..', 'resources', 'light', 'dependency',  media ?? 'dependency.svg'),
      dark: path.join(__dirname, '..', '..', '..', 'resources', 'dark', 'dependency', media ?? 'dependency.svg')
      };
   }
 }
}