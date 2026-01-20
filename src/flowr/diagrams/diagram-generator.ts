import { getConfig, Settings } from '../../settings';
import { assertUnreachable } from '@eagleoutice/flowr/util/assert';
import * as vscode from 'vscode';
import type { DiagramOptions, DiagramOptionsCheckbox, DiagramOptionsDropdown } from './diagram-definitions';

export interface DiagramGeneratorData {
    mermaid:          string;
    options:          DiagramOptions;
    documentationUrl: string;
    editorUrl:        string;
    id:               string;
    name:             string;
}

const Checkbox =  {
	html: (option: DiagramOptionsCheckbox) => {
		return `<label><input id="${option.keyInSet ?? option.key}" type="checkbox" ${option.currentValue ? 'checked' : ''}>${option.displayText}</label>`;
	},
	js: (option: DiagramOptionsCheckbox) => {
		return `document.getElementById('${option.keyInSet ?? option.key}').addEventListener('change', (e) => {
			vscode.postMessage({ key: '${option.key}', value: event.currentTarget.checked, keyInSet: ${option.keyInSet ? `'${option.keyInSet}'` : undefined} });
        });`;
	}
};

const Dropdown = {
	html: (option: DiagramOptionsDropdown) => {
		const optionsStr = option.values.map(o => `<option value="${o.value}" ${option.currentValue === o.value ? 'selected="selected"' : ''}>${o.displayText}</option>`).join('\n');
		return `<select id="${option.key}">${optionsStr}</select>`;
	},
	js: (option: DiagramOptionsDropdown) => {
		return `const input = document.getElementById('${option.key}');
		input.addEventListener('change', (e) => {
			vscode.postMessage({ key: '${option.key}', value: input.options[e.currentTarget.selectedIndex].value});
		});`;
	}
};

function generateOptionsHTML(options: DiagramOptions): string {
	return Object.values(options).map(option => {
		switch(option.type) {
			case 'checkbox': return Checkbox.html(option);
			case 'dropdown': return Dropdown.html(option);
			default: assertUnreachable(option);
		}
	}).join('\n');
}

function generateOptionsJS(options: DiagramOptions): string {
	return Object.values(options).map(option => {
		switch(option.type) {
			case 'checkbox': return Checkbox.js(option);
			case 'dropdown': return Dropdown.js(option);
			default: assertUnreachable(option);
		}
	}).join('\n');
}

function createDiagramDocument({ mermaid, options, documentationUrl, editorUrl }: DiagramGeneratorData): string {
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
        :root { 
            --footer-height: 40px; 
            --header-height: 40px;
        }

        .container {
            display: grid;
            grid-template-columns: 1fr;
            grid-template-rows: min-content 1fr min-content;
            grid-column-gap: 0px;
            grid-row-gap: 0px;
            height: 100vh;
            width: 100%;
        }

        .mermaid svg {
            max-width: 100% !important;
            max-height: 100% !important;
            height: 100%;
            width: 100%;
        }

        .header {
            height: var(--header-height);  
            display: flex; 
            justify-content: flex-end;
            align-items: center;
            gap: 8px;
        }

        .footer {
            height: var(--footer-height);
            display: flex; 
            align-items: center;
            gap: 8px;
            margin-left: 10px;
        }

        .footer select, .footer input[type="checkbox"] {
            color: inherit;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
        }
        .footer label { display: inline-flex; align-items: center; gap: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <a href="${documentationUrl}">Documentation</a>
            <a href="${editorUrl}">Open in Mermaid</a>
        </div>

        <div class="mermaid" id="diagram">
            ${mermaid}
        </div>
        
        <div class="footer">
            ${generateOptionsHTML(options)}
        </div>
    </div>

    
    <script>
        const vscode = acquireVsCodeApi();
        
        /* Mermaid Rendering */
        let panZoom; 
        mermaid.run().then(() => {
            panZoom = svgPanZoom('.mermaid svg', { controlIconsEnabled: true })
            addEventListener("resize", () => panZoom.resize())
        });

        /* Communication with extension */
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

       ${generateOptionsJS(options)}
    </script>
</body>
</html>`;
}

function mermaidMaxTextLength() {
	return getConfig().get<number>(Settings.StyleMermaidMaxTextLength, 500000);
}

export function createDiagramWebview(data: DiagramGeneratorData, output: vscode.OutputChannel): vscode.WebviewPanel | undefined {
	// https://github.com/mermaid-js/mermaid/blob/47601ac311f7ad7aedfaf280d319d75434680622/packages/mermaid/src/mermaidAPI.ts#L315-L317
	if(data.mermaid.length > mermaidMaxTextLength()){
		void vscode.window.showErrorMessage('The diagram is too large to be displayed by Mermaid. You can find its code in the flowR output panel instead. Additionally, you can change the maximum diagram length in the extension settings.');
		output.appendLine(data.mermaid);
		return undefined;
	}

	const panel = vscode.window.createWebviewPanel(data.id, data.name, vscode.ViewColumn.Beside, {
		enableScripts: true
	});
	panel.webview.html = createDiagramDocument(data);
	return panel;
}

