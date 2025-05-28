import * as vscode from 'vscode';
import { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { VertexType } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { resolveIdToValue } from '@eagleoutice/flowr/dataflow/environments/resolve-by-name';
import { RLogicalValue } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-logical';
import { RNumberValue, RStringValue } from '@eagleoutice/flowr/r-bridge/lang-4.x/convert-values';
import { getFlowrSession } from '../../extension';
import { DataflowGraph } from '@eagleoutice/flowr/dataflow/graph/graph';
import { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';

export function registerInlineHints(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.languages.registerInlayHintsProvider(
		// only for r
		{ scheme: 'file', language: 'r' },
		new FlowrInlayHintsProvider(output)
	)
}

class FlowrInlayHintsProvider implements vscode.InlayHintsProvider {
	private readonly output: vscode.OutputChannel;
	private readonly updateEvent = new vscode.EventEmitter<void>();
	public onDidChangeInlayHints = this.updateEvent.event;

	// TODO: work with the server as well
	// TODO: merge infrastructure with dependency viewer?
	private graphInfo: DataflowGraph | undefined;
	private normalizeInfo: NormalizedAst | undefined;
	// TODO: on update event etc.

	constructor(output: vscode.OutputChannel) {
		this.output = output;
		// TODO: register disposables
		vscode.workspace.onDidChangeTextDocument(e => {
			if(e.document.languageId === 'r') {
				void this.update();
			}
		})
		vscode.window.onDidChangeActiveTextEditor(e => {
			if(e?.document.languageId === 'r') {
				void this.update();
			}
		})
		setTimeout(() => void this.update(), 50);
		setTimeout(() => void this.update(), 250);
	}

	private lastEditorContent: string | undefined;
	async update(): Promise<void> {
		const active = vscode.window.activeTextEditor;
		if(!active) {
			return;
		}
		const content = active.document.getText();
		if(content.trim() === this.lastEditorContent) {
			return;
		}
		this.lastEditorContent = content.trim();

		
		const session = await getFlowrSession();
		
		const res = (await session.retrieveQuery(active.document, [{ type: 'dataflow' }, { type: 'normalized-ast' }]));
		this.graphInfo = res.result.dataflow.graph;
		this.normalizeInfo = res.result['normalized-ast'].normalized;
		
		this.updateEvent.fire();
	}

	private collectAllVariables(): Set<NodeId> {
		if(!this.graphInfo) {
			return new Set();
		}
		const variables = new Set<NodeId>();
		for(const [v,info] of this.graphInfo.vertices(true)) {
			if(info.tag === VertexType.Use) {
				variables.add(v);
			}
		}
		return variables;
	}

	private getValuesForVariable(variable: NodeId): string[] {
		if(!this.graphInfo || !this.normalizeInfo) {
			return [];
		}
		const values = resolveIdToValue(variable, { graph: this.graphInfo, full: true, idMap: this.normalizeInfo.idMap });
		return values?.map(unwrapRValue).filter(isNotUndefined) ?? [];
	}

	provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): vscode.ProviderResult<vscode.InlayHint[]> {
		if(!this.graphInfo || !this.normalizeInfo) {
			return [];
		}
		// TODO: respect hints
		const variables = [...this.collectAllVariables()].map(v => [v, this.getValuesForVariable(v)] as const);
		const results: vscode.InlayHint[] = [];

		for(const [variable, values] of variables) {
			if(values.length === 0) {
				continue;
			}
			const loc = this.normalizeInfo.idMap?.get(variable);
			if(!loc?.location) {
				continue;
			}
			const vals = values.join(' | ');
			const position = new vscode.Position(loc.location[0] - 1, loc.location[1]);
			results.push({
				label: `: ${vals}`,
				tooltip: 'Values: ' + vals,
				kind: vscode.InlayHintKind.Parameter,
				position,
				paddingLeft:	 true
			})
		}

		return results;
	}
}

// maybe take from flowR
function unwrapRValue(value: RLogicalValue | RStringValue | RNumberValue | string | number | unknown): string | undefined {
	if(value === undefined) {
		return undefined;
	}
	switch(typeof value) {
		case 'string':
			return value;
		case 'number':
			return value.toString();
		case 'boolean':
			return value ? 'TRUE' : 'FALSE';
	}
	if(typeof value !== 'object' || value === null) {
		return JSON.stringify(value);
	}
	if('str' in value) {
		return (value as RStringValue).str;
	} else if('num' in value) {
		return (value as RNumberValue).num.toString();
	} else {
		return JSON.stringify(value);
	}
}

function isNotUndefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}