import * as vscode from 'vscode';
import { telemetry } from './extension';

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
    ChangedSelection = 'changed-selection'
}

export interface TelemetryEventArgs extends Record<string, unknown> {
    timestamp: number
}

export function registerTelemetryEvents(subscriptions: vscode.Disposable[]) {
	subscriptions.push(vscode.workspace.onDidOpenTextDocument(d => telemetry.event(TelemetryEvent.OpenedDocument, { document: d.uri.toString() })));
	subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(d => telemetry.event(TelemetryEvent.OpenedDocument, { document: d.uri.toString() })));
	subscriptions.push(vscode.workspace.onDidCloseTextDocument(d => telemetry.event(TelemetryEvent.ClosedDocument, { document: d.uri.toString() })));
	subscriptions.push(vscode.workspace.onDidCloseNotebookDocument(d => telemetry.event(TelemetryEvent.ClosedDocument, { document: d.uri.toString() })));

	subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => telemetry.event(TelemetryEvent.ChangedActiveEditor, { document: e?.document.uri.toString() || null })));
	subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(e => telemetry.event(TelemetryEvent.ChangedActiveEditor, { document: e?.notebook.uri.toString() || null })));
	subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
		if(e.textEditor?.document.uri.scheme !== 'output') {
			return telemetry.event(TelemetryEvent.ChangedSelection, { document: e.textEditor?.document.uri.toString(), selections: e.selections });
		}
	}));
	subscriptions.push(vscode.window.onDidChangeNotebookEditorSelection(e => telemetry.event(TelemetryEvent.ChangedSelection, { document: e.notebookEditor?.notebook.uri.toString(), selections: e.selections })));
}
