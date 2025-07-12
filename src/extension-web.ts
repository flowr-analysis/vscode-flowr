import * as vscode from 'vscode';
import { activateFlowrExtension, setWebMode } from './main';

export async function activate(context: vscode.ExtensionContext) {
   setWebMode(true);
   activateFlowrExtension(context);
}