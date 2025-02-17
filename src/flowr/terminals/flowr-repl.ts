import * as vscode from 'vscode';
import type { FlowrSession } from '../utils';
import { ansiFormatter } from '@eagleoutice/flowr/util/ansi';
import * as readline from 'readline';
import { Stream } from 'stream';
import { replCompleter } from '@eagleoutice/flowr/cli/repl/core';

export function showRepl(context: vscode.ExtensionContext, session: FlowrSession) {
	const writeEmitter = new vscode.EventEmitter<string>();
	// make a readable stream
	const readable = new Stream.Readable({
		read() {}
	});
	const writable = new Stream.Writable({
		write(chunk: { toString: () => string }, encoding, callback: () => void) {
			writeEmitter.fire(chunk.toString());
			callback();
		}
	});
	const terminal = vscode.window.createTerminal({
		name: 'flowr REPL',
		pty:  {
			onDidWrite: writeEmitter.event,
			open:       () => {
				void session.runRepl({
					allowRSessionAccess: true,
					history:             [],
					output:              {
						formatter: ansiFormatter,
						stdout(text: string) { 
							writeEmitter.fire(text.replaceAll('\n', '\r\n') + '\r\n');
						},
						stderr(text: string) {
							writeEmitter.fire(text.replaceAll('\n', '\r\n') + '\r\n');
						}
					},
					rl: readline.createInterface({
						input:                   readable,
						output:                  writable,
						tabSize:                 4,
						terminal:                true,
						history:                 [],
						removeHistoryDuplicates: true,
						completer:               replCompleter
					} satisfies readline.ReadLineOptions)
				});
			}, // Called when terminal is opened
			close:       () => {}, // Called when terminal is closed
			handleInput: (data: string) => {
				readable.push(data);
			}
		}
	});

	terminal.show();
}
