import * as vscode from 'vscode';
import { PipelineOutput } from '@eagleoutice/flowr/core/steps/pipeline/pipeline';
import { TREE_SITTER_DATAFLOW_PIPELINE, createDataflowPipeline } from '@eagleoutice/flowr/core/steps/pipeline/default-pipelines';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { requestFromInput } from '@eagleoutice/flowr/r-bridge/retriever';
import { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { VertexType } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { resolve } from '@eagleoutice/flowr/dataflow/environments/resolve-by-name';
import { RLogicalValue } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-logical';
import { RNumberValue, RStringValue } from '@eagleoutice/flowr/r-bridge/lang-4.x/convert-values';

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
	private analysisInfo: PipelineOutput<typeof TREE_SITTER_DATAFLOW_PIPELINE> | undefined;
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
		this.output.appendLine('Updating inlay hints');
		const active = vscode.window.activeTextEditor;
		if(!active) {
			return;
		}
		const content = active.document.getText();
		if(content.trim() === this.lastEditorContent) {
			return;
		}
		this.lastEditorContent = content.trim();

		this.analysisInfo = await createDataflowPipeline(new TreeSitterExecutor(), {
			request: requestFromInput(content)
		}).allRemainingSteps();
		this.updateEvent.fire();
	}

	private collectAllVariables(): Set<NodeId> {
		if(!this.analysisInfo) {
			return new Set();
		}
		const variables = new Set<NodeId>();
		for(const [v,info] of this.analysisInfo.dataflow.graph.vertices(true)) {
			if(info.tag === VertexType.Use) {
				variables.add(v);
			}
		}
		return variables;
	}

	private getValuesForVariable(variable: NodeId): string[] {
		if(!this.analysisInfo) {
			return [];
		}
		const values = resolve(variable, { graph: this.analysisInfo.dataflow.graph, full: true, idMap: this.analysisInfo.normalize.idMap });

		return values?.map(unwrapRValue).filter(isNotUndefined) ?? [];
	}

	provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): vscode.ProviderResult<vscode.InlayHint[]> {
		if(!this.analysisInfo) {
			return [];
		}
		// TODO: respect hints
		const variables = [...this.collectAllVariables()].map(v => [v, this.getValuesForVariable(v)] as const);
		const results: vscode.InlayHint[] = [];

		for(const [variable, values] of variables) {
			if(values.length === 0) {
				continue;
			}
			const loc = this.analysisInfo.normalize.idMap.get(variable);
			if(!loc?.location) {
				continue;
			}
			const vals = values.join(' | ');
			results.push({
				label: `: ${vals}`,
				kind: vscode.InlayHintKind.Type,
				position: new vscode.Position(loc.location[2], loc.location[3] - 1),
				paddingLeft: true
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