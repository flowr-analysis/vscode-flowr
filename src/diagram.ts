import * as vscode from 'vscode';
import { getConfig, getFlowrSession } from './extension';
import { Settings } from './settings';

export function registerDiagramCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.dataflow', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		if(activeEditor) {
			const mermaid = await (await getFlowrSession()).retrieveDataflowMermaid(activeEditor.document);
			if(mermaid) {
				return { mermaid, webview: createWebview('flowr-dataflow', 'Dataflow Graph', mermaid, output) };
			}
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.dataflow-simplified', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		if(activeEditor) {
			const mermaid = await (await getFlowrSession()).retrieveDataflowMermaid(activeEditor.document, true);
			if(mermaid) {
				return { mermaid, webview: createWebview('flowr-dataflow', 'Dataflow Graph', mermaid, output) };
			}
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.ast', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		if(activeEditor) {
			const ast = await (await getFlowrSession()).retrieveAstMermaid(activeEditor.document);
			if(ast) {
				createWebview('flowr-ast', 'AST', ast, output);
			}
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.cfg', async() => {
		const activeEditor = vscode.window.activeTextEditor;
		if(activeEditor) {
			const cfg = await (await getFlowrSession()).retrieveCfgMermaid(activeEditor.document);
			if(cfg) {
				createWebview('flowr-cfg', 'Control Flow Graph', cfg, output);
			}
		}
	}));
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
	return `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">

	<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
	<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
	<script>
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'loose',
			theme: '${theme}',
			maxTextSize: ${mermaidMaxTextLength()},
			// we set maxEdges so that it's never able to trigger, since we only safeguard against maxTextSize
			maxEdges: Number.MAX_SAFE_INTEGER
		})
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
	<pre class="mermaid">
		${mermaid}
	</pre>
	<script>
		mermaid.run().then(() => {
			const panZoom = svgPanZoom('.mermaid svg', { controlIconsEnabled: true })
			addEventListener("resize", () => panZoom.resize())
		})
	</script>
</body>
</html>`;
}

function mermaidMaxTextLength() {
	return getConfig().get<number>(Settings.StyleMermaidMaxTextLength, 500000);
}
