import * as vscode from 'vscode';

export abstract class Telemetry {

	abstract start(userPseudonym: string): void;

	abstract stop(): void | Promise<void>;

	abstract event(event: TelemetryEvent, args: Omit<TelemetryEventArgs, 'timestamp'>): void;

	eventCommand(command: string, args: unknown[]): void {
		this.event(TelemetryEvent.UsedCommand, { command, args });
	}
}

export class NoTelemetry extends Telemetry {
	start(): void {}
	stop(): void {}
	event(): void {}
}

export class LocalTelemetry extends Telemetry {

	private readonly outputChannel: vscode.OutputChannel;
	private readonly events:        Map<TelemetryEvent, TelemetryEventArgs[]> = new Map<TelemetryEvent, TelemetryEventArgs[]>();
	private userPseudonym:          string | undefined = undefined;

	constructor(outputChannel: vscode.OutputChannel) {
		super();
		this.outputChannel = outputChannel;
	}

	start(userPseudonym: string): void {
		this.userPseudonym = userPseudonym;
		this.outputChannel.appendLine('[Telemetry] Started local telemetry');
	}

	async stop(): Promise<void> {
		const results = JSON.stringify({
			userPseudonym: this.userPseudonym,
			events:        Object.fromEntries(this.events)
		});
		const file = await vscode.workspace.openTextDocument({ language: 'json', content: results });
		vscode.window.showTextDocument(file);
		this.outputChannel.appendLine('[Telemetry] Stopped local telemetry');
	}

	event(event: TelemetryEvent, args: Omit<TelemetryEventArgs, 'timestamp'>): void {
		if(!this.events.has(event)) {
			this.events.set(event, []);
		}
		this.outputChannel.appendLine(`[Telemetry] Recording event ${event}`);
		(this.events.get(event) as TelemetryEventArgs[]).push({
			...args,
			timestamp: Date.now()
		});
	}

}

export enum TelemetryEvent {
    UsedCommand = 'used-command',
    OpenedDocument = 'opened-document',
    ClosedDocument = 'closed-document',
    ChangedActiveEditor = 'changed-active-editor',
    ChangedSelection = 'changed-selection',
    ChangedFile = 'changed-file'
}

export interface TelemetryEventArgs extends Record<string, unknown> {
    timestamp: number
}

export let telemetry: Telemetry = new NoTelemetry();

export function registerTelemetry(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.telemetry.start-local', async() => {
		if(!(telemetry instanceof NoTelemetry)) {
			vscode.window.showWarningMessage('Telemetry is already active.');
			return;
		}
		const pseudonym = await vscode.window.showInputBox({ title: 'flowR Telemetry Pseudonym', prompt: 'Input the pseudonym to output telemetry data under. Telemetry is only collected locally, and only collected after a pseudonym is set. After stopping telemetry using the Stop Telemetry command, all collected data is dumped to a local JSON file.', ignoreFocusOut: true });
		if(pseudonym?.length){
			telemetry = new LocalTelemetry(output);
			telemetry.start(pseudonym);
			vscode.window.showInformationMessage(`Started telemetry with pseudonym ${pseudonym}.`);
		} else {
			vscode.window.showWarningMessage('No pseudonym set. Not starting telemetry.');
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.telemetry.stop', async() => {
		if(telemetry instanceof NoTelemetry) {
			vscode.window.showWarningMessage('Telemetry not active.');
			return;
		}
		await telemetry.stop();
		telemetry = new NoTelemetry();
		vscode.window.showInformationMessage('Stopped telemetry.');
	}));

	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(d => telemetry.event(TelemetryEvent.OpenedDocument, { 
		document: d.uri.toString(),
		content:  d.getText() 
	})));
	context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(d => telemetry.event(TelemetryEvent.OpenedDocument, {
		document: d.uri.toString() 
	})));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(d => telemetry.event(TelemetryEvent.ClosedDocument, {
		document: d.uri.toString(),
		content:  d.getText()
	})));
	context.subscriptions.push(vscode.workspace.onDidCloseNotebookDocument(d => telemetry.event(TelemetryEvent.ClosedDocument, {
		document: d.uri.toString() 
	})));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
		if(e.document.uri.scheme !== 'output') {
			telemetry.event(TelemetryEvent.ChangedFile, { 
				document: e.document?.uri.toString(),
				changes:  e.contentChanges, 
				reason:   e.reason, 
				// eslint-disable-next-line no-warning-comments
				// TODO: we shouldn't just use the document text here! instead, we should generate some sort of diff -> but how do we get the diff? it seems like the old content pre-change is not available, so maybe we have to track that ourselves? :(
				ontent:   e.document.getText() 
			});
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeNotebookDocument(e => telemetry.event(TelemetryEvent.ChangedFile, { 
		document:    e.notebook?.uri.toString(), 
		changes:     e.contentChanges, 
		cellChanges: e.cellChanges
	})));

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => telemetry.event(TelemetryEvent.ChangedActiveEditor, { 
		document: e?.document.uri.toString(), 
		content:  e?.document.getText()
	})));
	context.subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(e => telemetry.event(TelemetryEvent.ChangedActiveEditor, {
		document: e?.notebook.uri.toString()
	})));
	context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
		if(e.textEditor?.document.uri.scheme === 'output') {
			telemetry.event(TelemetryEvent.ChangedSelection, {
				document:   e.textEditor?.document.uri.toString(),
				selections: e.selections
			});
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeNotebookEditorSelection(e => telemetry.event(TelemetryEvent.ChangedSelection, { 
		document:   e.notebookEditor?.notebook.uri.toString(),
		selections: e.selections
	})));

}
