import * as vscode from 'vscode';
import { registerCommand } from '../../extension';
import { DiagramSettingsPrefix, getConfig } from '../../settings';
import path from 'path';
import { createDiagramWebview } from './diagram-generator';
import type { DiagramOption , DiagramOptions, FlowrDiagramType } from './diagram-definitions';
import { DiagramDefinitions } from './diagram-definitions';

export function registerDiagramCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const coordinator = new DiagramUpdateCoordinator(output);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			coordinator.onSelectionChanged(e);
		})
	);

	for(const type in DiagramDefinitions) {
		const definition = DiagramDefinitions[type as FlowrDiagramType];
		registerCommand(context, definition.command, async() => {
			const activeEditor = vscode.window.activeTextEditor;
			return await coordinator.createDiagramPanel(type as FlowrDiagramType, activeEditor);
		});
	}
}

interface DiagramPanelInformation {
	type:    FlowrDiagramType;
	panel:   vscode.WebviewPanel;
	options: DiagramOptions;
}

interface ContentUpdateMessage {
	type:    'content_update',
	content: string
}

interface WebviewMessage {
	key:       string 
	/** @see DiagramOptionsCheckbox.keyInSet */
	keyInSet?: string
	value:     unknown
}


/**
 * Manages Webview Panels created through flowr commands (like Show Dataflow Graph)
 * This also routes updates to the correct panel when the text selection updates in a panel
 */
class DiagramUpdateCoordinator {
	private documentToDiagramPanel: Map<vscode.TextDocument, Set<DiagramPanelInformation>>;
	private output:                 vscode.OutputChannel;
	private debounceTimeout:        NodeJS.Timeout | undefined;
	private debounceTime = 250; //ms

	constructor(output: vscode.OutputChannel) {
		this.documentToDiagramPanel = new Map<vscode.TextDocument, Set<DiagramPanelInformation>>();
		this.output = output;
	}

	public async createDiagramPanel(type: FlowrDiagramType, editor: vscode.TextEditor | undefined) {
		if(!editor) {
			return;
		}
 
		const definition = DiagramDefinitions[type];
		const options = optionsFromDiagramType(type);
		const mermaid = await definition.retrieve(options, editor);

		const panel = createDiagramWebview({
			mermaid:          mermaid,
			options:          options,
			documentationUrl: definition.documentationUrl,
			editorUrl:        '',
			id:               type as string,
			name:             `${definition.title} (${path.basename(editor.document.fileName)})`
		}, this.output);

		if(!panel) {
			return undefined;
		}

		const info = { type, panel, options } satisfies DiagramPanelInformation;

		// Stop tracking panel when user closes it
		panel.onDidDispose(() => {
			this.documentToDiagramPanel.get(editor.document)?.delete(info);
		});

		// Handle settings update messages from panel
		panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
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
		});

		// Add panel to map for tracking selection updates
		if(!this.documentToDiagramPanel.has(editor.document)) {
			this.documentToDiagramPanel.set(editor.document, new Set<DiagramPanelInformation>());
		}

		this.documentToDiagramPanel.get(editor.document)?.add(info);

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
		const mermaid = await DiagramDefinitions[info.type].retrieve(info.options, textEditor);

		const mermaid = await diagramFromTypeAndEditor(info.type, textEditor, info.options);
		info.panel.webview.postMessage({
			type:    'content_update',
			content: mermaid
		} satisfies ContentUpdateMessage);
	}
}

type OptionsFor<T extends FlowrDiagramType> = (typeof DiagramDefinitions)[T]['options'];

function assertOptionsMatch<T extends FlowrDiagramType>(type: T, options: DiagramOptions): asserts options is OptionsFor<T> {
	for(const key of Object.keys(DiagramDefinitions[type].options)) {
		if(!(key in options)) {
			throw new Error(`Missing option '${key}' for diagram type '${type}'`);
		}
	}
}

async function retrieveDiagram<T extends FlowrDiagramType, O extends OptionsFor<T>>(type: T, options: O, editor: vscode.TextEditor) {
	assertOptionsMatch(type, options);
	return await DiagramDefinitions[type].retrieve(options, editor);
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

