import * as vscode from 'vscode';
import { registerCommand } from '../../extension';
import { DiagramSettingsPrefix, getConfig } from '../../settings';
import path from 'path';
import { createDiagramWebview } from './diagram-generator';
import type { DiagramOption, DiagramOptions, FlowrDiagramType } from './diagram-definitions';
import { DiagramDefinitions } from './diagram-definitions';
import { Mermaid } from '@eagleoutice/flowr/util/mermaid/mermaid';

/**
 *
 */
export function registerDiagramCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const coordinator = new DiagramUpdateCoordinator(output);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			coordinator.onSelectionChanged(e);
		})
	);

	for(const type in DiagramDefinitions) {
		const definition = DiagramDefinitions[type as FlowrDiagramType];
		registerCommand(context, definition.command, (callbacks?: WebviewCallbacks) => {
			const activeEditor = vscode.window.activeTextEditor;
			return coordinator.createDiagramPanel(type as FlowrDiagramType, activeEditor, callbacks);
		});
	}
}

interface DiagramPanelInformation {
	type:    FlowrDiagramType;
	panel:   vscode.WebviewPanel;
	options: DiagramOptions;
}

/**
 * Sent by the extension to the webview when there is new mermaid code to show
 */
interface ContentUpdateMessage {
	type:      'content_update';
	content:   string;
	editorUrl: string;
}

/**
 * Sent when the webview is ready to recieve mermaid code
 */
interface WebviewReadyMessage {
	type: 'ready';
}

/**
 * Sent by the webview when an error occured during diagram conversion using mermaid
 */
interface WebviewErrorMessage {
	type:    'error';
	message: string;
}

/**
 * Sent by the webview when a mermaid diagram
 * was successfully genereted and converted into svg
 */
interface WebviewDiagramGeneratedMessage {
	type: 'diagram_generated';
}

/**
 * Sent by the Webview when settings were changed by the user.
 * Settings include the checkboxes and dropdowns in the webview pane
 */
interface WebviewSettingsMessage {
	type:      'settings'
	key:       string
	/** @see DiagramOptionsCheckbox.keyInSet */
	keyInSet?: string
	value:     unknown
}

type WebviewMessage = WebviewReadyMessage | WebviewSettingsMessage | WebviewErrorMessage | WebviewDiagramGeneratedMessage;

export type WebviewCallbacks = { onError: (message: string) => void, onGenerated: () => void };


/**
 * Manages Webview Panels created through flowr commands (like Show Dataflow Graph)
 * This also routes updates to the correct panel when the text selection updates in a panel
 */
export class DiagramUpdateCoordinator {
	private documentToDiagramPanel: Map<vscode.TextDocument, Set<DiagramPanelInformation>>;
	private output:                 vscode.OutputChannel;
	private debounceTimeout:        NodeJS.Timeout | undefined;
	private debounceTime = 250; //ms

	constructor(output: vscode.OutputChannel) {
		this.documentToDiagramPanel = new Map<vscode.TextDocument, Set<DiagramPanelInformation>>();
		this.output = output;
	}

	public createDiagramPanel(type: FlowrDiagramType, editor: vscode.TextEditor | undefined, callbacks?: WebviewCallbacks) {
		if(!editor) {
			return;
		}

		const definition = DiagramDefinitions[type];
		const options = optionsFromDiagramType(type);
		const panel = createDiagramWebview({
			options:          options,
			documentationUrl: definition.documentationUrl,
			id:               type as string,
			name:             `${definition.title} (${path.basename(editor.document.fileName)})`
		});

		if(!panel) {
			return undefined;
		}

		const info = { type, panel, options } satisfies DiagramPanelInformation;

		// Stop tracking panel when user closes it
		panel.onDidDispose(() => {
			this.documentToDiagramPanel.get(editor.document)?.delete(info);
		});

		// Add panel to map for tracking selection updates
		if(!this.documentToDiagramPanel.has(editor.document)) {
			this.documentToDiagramPanel.set(editor.document, new Set<DiagramPanelInformation>());
		}

		this.documentToDiagramPanel.get(editor.document)?.add(info);

		const onReady = () => {
			void this.updateWebviewPanel(info, editor);
		};

		const onSettingsChanged = (msg: WebviewSettingsMessage) => {
			const key = `${DiagramSettingsPrefix}.${msg.key}`;
			if(msg.keyInSet) { // If setKey is set, the checkboxes are grouped into an array
				const current = new Set(getConfig().get<string[]>(key, []));
				if(msg.value) {
					current.add(msg.keyInSet);
				} else {
					current.delete(msg.keyInSet);
				}
				((options as Record<string, DiagramOption>)[msg.keyInSet].currentValue as unknown) = msg.value;
				getConfig().update(key, current.values().toArray());
			} else {
				((options as Record<string, DiagramOption>)[msg.key].currentValue as unknown) = msg.value;
				getConfig().update(key, msg.value);
			}

			void this.updateWebviewPanel(info, editor);
		};

		// Handle messages from panel
		panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
			switch(msg.type) {
				case 'ready': onReady(); break;
				case 'settings': onSettingsChanged(msg); break;
				case 'error': callbacks?.onError(msg.message); break;
				case 'diagram_generated': callbacks?.onGenerated(); break;
			}
		});

		return {
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
			const panelsToUpdate = this.documentToDiagramPanel.get(e.textEditor.document);
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
		const mermaid = await DiagramDefinitions[info.type].retrieve(info.options as never, textEditor);
		info.panel.webview.postMessage({
			type:      'content_update',
			content:   mermaid,
			editorUrl: Mermaid.codeToUrl(mermaid, true)
		} satisfies ContentUpdateMessage);
	}
}
function optionsFromDiagramType<T extends FlowrDiagramType>(type: T): (typeof DiagramDefinitions)[T]['options'] {
	const options = DiagramDefinitions[type].options;

	for(const option of Object.values(options)) {
		if('keyInSet' in option && option.keyInSet) { // option is encoded in a set
			const rawSet = getConfig().get<string[]>(`${DiagramSettingsPrefix}.${option.key}`);
			if(rawSet === undefined) {
				option.currentValue = option.default;
				continue;
			}

			const set = new Set<string>(rawSet);
			option.currentValue = set.has(option.keyInSet);
		} else { // option is stored directly
			option.currentValue = getConfig().get(`${DiagramSettingsPrefix}.${option.key}`, option.default);
		}
	}

	return options;
}

