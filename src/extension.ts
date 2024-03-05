import * as vscode from 'vscode'

export function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	const disposable = vscode.commands.registerCommand('vscode-flowr.helloWorld', () => {
		void vscode.window.showInformationMessage('Hello World from vscode-flowr!')
	})

	context.subscriptions.push(disposable)
}

export function deactivate() {}
