import * as vscode from 'vscode';
import { FlowrSession } from '../utils';
import { ansiFormatter } from '@eagleoutice/flowr/util/ansi';
import * as readline from 'readline';
import { replCompleter } from '@eagleoutice/flowr/cli/repl/core';
import { Stream } from 'stream';

// TODO: check out if flowr works with dynamic import of clipboardy
export function showRepl(context: vscode.ExtensionContext, session: FlowrSession) {
   const writeEmitter = new vscode.EventEmitter<string>();
   // make a readable stream
   const readable = new Stream.Readable({
      read() {}
   });
   const writable = new Stream.Writable({
      write(chunk, encoding, callback) {
         writeEmitter.fire(chunk.toString());
         callback();
      }
   });
   const terminal = vscode.window.createTerminal({
      name: 'flowr REPL',
      pty: {
          onDidWrite: writeEmitter.event,
          open: () => {
            session.runRepl({
               allowRSessionAccess: true,
               output: {
                  formatter: ansiFormatter,
                  stdout(text: string) { 
                     writeEmitter.fire(text + '\n')
                  },
                  stderr(text: string) {
                     writeEmitter.fire(text)
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
            })
          }, // Called when terminal is opened
          close: () => {}, // Called when terminal is closed
          handleInput: (data: string) => {
              readable.push(data);
          }
      }
  });

  terminal.show();
}
