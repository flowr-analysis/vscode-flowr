import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import { Settings , getConfig } from './settings';
import path from 'path';
import assert from 'assert';

// odo: Checkbox + Dropdown + Command
// odo: Ast + Cfg  

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

interface DiagramPanelInformation {
	type:     FlowrDiagramType,
	panel:    vscode.WebviewPanel,
	simplify: boolean
}


interface ContentUpdateMessage {
	type:    'content_update',
	content: string
}


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
 
		// Initialize webview 
		const title = `${nameFromDiagramType(type)} (${path.basename(editor.document.fileName)})`;
		const mermaid = await diagramFromTypeAndEditor(type, editor, simplify);
		const panel = createWebview(type as string, title, mermaid, this.output);

		if(!panel) {
			return undefined;
		}

		const info = { type, panel, simplify } satisfies DiagramPanelInformation;

		// Stop tracking panel when user closes it
		panel.onDidDispose(() => {
			this.editorToDiagramPanel.get(editor)?.delete(info);
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
				void this.updateWebviewPanel(panel, e);
			}
		}, this.debounceTime);
	}

	public async updateWebviewPanel(info: DiagramPanelInformation, e: vscode.TextEditorSelectionChangeEvent) {
		const mermaid = await diagramFromTypeAndEditor(info.type, e.textEditor, info.simplify);
	
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

async function diagramFromTypeAndEditor(type: FlowrDiagramType, editor: vscode.TextEditor, simplified: boolean): Promise<string> {
	const session = await getFlowrSession();
	switch(type) {
		case FlowrDiagramType.Dataflow: return await session.retrieveDataflowMermaid(editor.document, editor.selections, simplified);
		case FlowrDiagramType.Controlflow: return await session.retrieveCfgMermaid(editor.document);
		case FlowrDiagramType.Ast: return await session.retrieveAstMermaid(editor.document);
		default: assert(false);
	}
}

function createWebview(id: string, name: string, mermaid: string, output: vscode.OutputChannel): vscode.WebviewPanel | undefined {
	// https://github.com/mermaid-js/mermaid/blob/47601ac311f7ad7aedfaf280d319d75434680622/packages/mermaid/src/mermaidAPI.ts#L315-L317
	if(mermaid.length > mermaidMaxTextLength()){
		void vscode.window.showErrorMessage('The diagram is too large to be displayed by Mermaid. You can find its code in the flowR output panel instead. Additionally, you can change the maximum diagram length in the extension settings.');
		output.appendLine(mermaid);
		return undefined;
	}

	const panel = vscode.window.createWebviewPanel(id, name, vscode.ViewColumn.Beside, {
		enableScripts: true
	});
	panel.webview.html = createDocument(mermaid);
	return panel;
}

function createDocument(mermaid: string) {
	const theme = vscode.window.activeColorTheme.kind == vscode.ColorThemeKind.Light ? 'default' : 'dark';
	// Use 'leet-html' extension for VS Code to get intellisense for the following string:
	return ` 
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">

	<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
	<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
	<script>
		const mermaidConfig = {
			startOnLoad: false,
			securityLevel: 'loose',
			theme: '${theme}',
			maxTextSize: ${mermaidMaxTextLength()},
			// we set maxEdges so that it's never able to trigger, since we only safeguard against maxTextSize
			maxEdges: Number.MAX_SAFE_INTEGER
		};
		mermaid.initialize(mermaidConfig);
	</script>

	<style>
		.mermaid svg {
			position: absolute;
			max-width: 100% !important;
			max-height: 100% !important;
			width: 100%;
			height: 100%;
			top: 0;
			left: 0;
		}
	</style>
</head>
<body>
	<div class="mermaid" id="diagram">
		${mermaid}
	</div>
	<script>
		let panZoom; 
		mermaid.run().then(() => {
			panZoom = svgPanZoom('.mermaid svg', { controlIconsEnabled: true })
			addEventListener("resize", () => panZoom.resize())
		});

		window.addEventListener('message', async event => {
			const msg = event.data;
			switch(msg.type) {
				case 'content_update':
					const el = document.getElementById('diagram');
					const { svg, bindFunctions } = await mermaid.render('flowr-diagram', msg.content);
					el.innerHTML = svg;
					bindFunctions?.(el);
					panZoom = svgPanZoom('.mermaid svg', { controlIconsEnabled: true })
					break;
			}
		});
	</script>
</body>
</html>`;
}

function mermaidMaxTextLength() {
	return getConfig().get<number>(Settings.StyleMermaidMaxTextLength, 500000);
}
