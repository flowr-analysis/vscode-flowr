import * as vscode from 'vscode'
import * as assert from 'assert'
import { activateExtension, openTestFile } from './test-util'

suite('slice', () => {
	suiteSetup(async() => {
		await activateExtension()
	})

	test('reconstruct cursor', async() => {
		await openTestFile('example.R', new vscode.Selection(7, 6, 7, 6))
		const newEditor: vscode.TextEditor | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor-reconstruct')
		assert.ok(newEditor)
		assert.equal(vscode.window.activeTextEditor, newEditor)
		assert.ok(newEditor.document.fileName.startsWith('Untitled-'))
		assert.equal(newEditor.document.getText(), `
product <- 1
n <- 10
for(i in 1:(n - 1)) product <- product * i
			`.trim())
	})

	test('slice cursor', async() => {
		await openTestFile('example.R', new vscode.Selection(7, 6, 7, 6))
		const slice: string | undefined = await vscode.commands.executeCommand('vscode-flowr.slice.cursor')
		assert.equal(slice, `
product <- 1
n <- 10
for(i in 1:(n - 1)) product <- product * i
			`.trim())
	})
})
