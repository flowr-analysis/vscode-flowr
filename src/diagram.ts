import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import {  DiagramSettingsKeys, DiagramSettingsPrefix, getConfig } from './settings';
import path from 'path';
import assert from 'assert';
import type { DiagramOption, DiagramOptions , DiagramOptionsCheckbox, DiagramOptionsDropdown } from './diagram-generator';
import { createDiagramWebview } from './diagram-generator';
import { assertUnreachable } from '@eagleoutice/flowr/util/assert';
import { CfgSimplificationPasses } from '@eagleoutice/flowr/control-flow/cfg-simplification';

export function registerDiagramCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const coordinator = new DiagramUpdateCoordinator(output);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			coordinator.onSelectionChanged(e);
		})
	);

	registerCommand(context, 'vscode-flowr.dataflow', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		return await coordinator.createDiagramPanel(FlowrDiagramType.Dataflow, activeEditor);
	});
	registerCommand(context, 'vscode-flowr.dataflow-simplified', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		return await coordinator.createDiagramPanel(FlowrDiagramType.Dataflow, activeEditor, true);
	});
	registerCommand(context, 'vscode-flowr.ast', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		return await coordinator.createDiagramPanel(FlowrDiagramType.Ast, activeEditor);
	});
	registerCommand(context, 'vscode-flowr.cfg', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		return await coordinator.createDiagramPanel(FlowrDiagramType.Controlflow, activeEditor);
	});
}

enum FlowrDiagramType {
	Dataflow = 'flowr-dataflow',
	Controlflow = 'flowr-cfg',
	Ast = 'flowr-ast'
}

interface DiagramPanelInformation<Options extends DiagramOptions = typeof DefaultDiagramOptions> {
	type:     FlowrDiagramType;
	panel:    vscode.WebviewPanel;
	simplify: boolean;
	options:  Options;
}

interface ContentUpdateMessage {
	type:    'content_update',
	content: string
}

interface WebviewMessage {
	key:   string, 
	value: unknown
}

export type DiagramSelectionMode = 'highlight' | 'hide';

/**
 * Manages Webview Panels created through flowr commands (like Show Dataflow Graph)
 * This also routes updates to the correct panel when the text selection updates in a panel
 */
class DiagramUpdateCoordinator {
	private editorToDiagramPanel: Map<vscode.TextEditor, Set<DiagramPanelInformation>>;
	private output:               vscode.OutputChannel;
	private debounceTimeout:      NodeJS.Timeout | undefined;
	private debounceTime = 250; //ms

	constructor(output: vscode.OutputChannel) {
		this.editorToDiagramPanel = new Map<vscode.TextEditor, Set<DiagramPanelInformation>>();
		this.output = output;
	}

	public async createDiagramPanel(type: FlowrDiagramType, editor: vscode.TextEditor | undefined, simplify: boolean = false) {
		if(!editor) {
			return;
		}
 
		const title = `${nameFromDiagramType(type)} (${path.basename(editor.document.fileName)})`;
		const options = optionsFromDiagramType(type) as typeof DefaultDiagramOptions;
		const mermaid = await diagramFromTypeAndEditor(type, editor, simplify, options.mode.currentValue);
		const panel = createDiagramWebview(type as string, title, mermaid, this.output, options);

		if(!panel) {
			return undefined;
		}

		const info = { type, panel, simplify, options } satisfies DiagramPanelInformation;

		// Stop tracking panel when user closes it
		panel.onDidDispose(() => {
			this.editorToDiagramPanel.get(editor)?.delete(info);
		});

		// Handle messages from panel
		panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
			// The messages are generated based on the Options object, so the keys must always exist
			((options as Record<string, DiagramOption>)[msg.key].currentValue as unknown) = msg.value; 
			void this.updateWebviewPanel(info, editor);
		});

		// Add panel to map for tracking selection updates
		if(!this.editorToDiagramPanel.has(editor)) {
			this.editorToDiagramPanel.set(editor, new Set<DiagramPanelInformation>());
		}

		this.editorToDiagramPanel.get(editor)?.add(info);

		return {
			mermaid,
			webview: panel
		};
	}

	public onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent) {
		// Debounce to avoid lots of updates when chaning selection quickly
		if(this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = undefined;
		}

		// Update when the last debounce timeout runs out
		this.debounceTimeout = setTimeout(() => {
			const panelsToUpdate = this.editorToDiagramPanel.get(e.textEditor);
			
			if(!panelsToUpdate) {
				return;
			}
			
			for(const panel of panelsToUpdate.values()) {
				if(panel.options.sync.currentValue) {
					void this.updateWebviewPanel(panel, e.textEditor);
				}
			}
		}, this.debounceTime);
	}

	public async updateWebviewPanel(info: DiagramPanelInformation, textEditor: vscode.TextEditor) {
		const mermaid = await diagramFromTypeAndEditor(info.type, textEditor, info.simplify, info.options.mode.currentValue);
		info.panel.webview.postMessage({
			type:    'content_update',
			content: mermaid
		} satisfies ContentUpdateMessage);
	}
}

function nameFromDiagramType(type: FlowrDiagramType): string {
	switch(type) {
		case FlowrDiagramType.Dataflow: return 'Dataflow Graph';
		case FlowrDiagramType.Controlflow: return 'Control Flow Graph';
		case FlowrDiagramType.Ast: return 'AST';
		default: return 'Flowr';
	}
}

const DefaultDiagramOptions = {
	mode: {
		type:   'dropdown',
		key:    DiagramSettingsKeys.Mode,
		values: [
			{ value: 'highlight', displayText: 'Highlight selection' },
			{ value: 'hide',      displayText: 'Only show selection' }
		],
		default:      'hide',
		currentValue: 'hide'
	} as DiagramOptionsDropdown<DiagramSelectionMode>,
	sync: {
		type:         'checkbox',
		key:          DiagramSettingsKeys.Sync,
		displayText:  'Sync with selection',
		default:      true,
		currentValue: true,
	},
} satisfies DiagramOptions;

type SimplificationPasses = keyof typeof CfgSimplificationPasses;
const CFGDiagramOptions = {
	// Default options for mode and sync
	...DefaultDiagramOptions,

	// Checkboxes for each simplification pass
	...(Object.fromEntries(Object.keys(CfgSimplificationPasses).map(v => [v, {
		type:         'checkbox',
		key:          v as DiagramSettingsKeys,
		displayText:  v,
		default:      true,
		currentValue: true
	}])) as { [K in SimplificationPasses]: DiagramOptionsCheckbox } )
} as const satisfies DiagramOptions;

function optionsFromDiagramType(type: FlowrDiagramType): DiagramOptions {
	let options;
	
	switch(type) {
		case FlowrDiagramType.Dataflow: 
			options = DefaultDiagramOptions; 
			break;
		case FlowrDiagramType.Controlflow: 
			options = CFGDiagramOptions;
			break;
		case FlowrDiagramType.Ast: 
			options = DefaultDiagramOptions; 
			break;
		default: assertUnreachable(type);
	}

	for(const option of Object.values(options)) {
		option.currentValue = getConfig().get(`${DiagramSettingsPrefix}.${option.key}`, option.default);
	}

	return options;
}

async function diagramFromTypeAndEditor(type: FlowrDiagramType, editor: vscode.TextEditor, simplified: boolean, selectionMode: DiagramSelectionMode): Promise<string> {
	const session = await getFlowrSession();
	switch(type) {
		case FlowrDiagramType.Dataflow: return await session.retrieveDataflowMermaid(editor.document, editor.selections, selectionMode, simplified);
		case FlowrDiagramType.Controlflow: return await session.retrieveCfgMermaid(editor.document, editor.selections, selectionMode);
		case FlowrDiagramType.Ast: return await session.retrieveAstMermaid(editor.document, editor.selections, selectionMode);
		default: assert(false);
	}
}
