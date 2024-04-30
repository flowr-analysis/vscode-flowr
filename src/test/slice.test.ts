import * as vscode from 'vscode'
import * as assert from 'assert'
import { activateExtension, openTestFile } from './test-util'

suite('slice', () => {
	suiteSetup(async() => {
		await activateExtension()
	})

	test('slice cursor', async() => {
		const editor = await openTestFile('example.R')
		editor.selection = new vscode.Selection(7, 6, 7, 6)
		const slice = await vscode.commands.executeCommand('vscode-flowr.slice.cursor')
		assert.equal(slice, `
product <- 1
n <- 10
for(i in 1:(n - 1)) product <- product * i
			`.trim())
	})

	test('reconstruct cursor', async() => {
		const editor = await openTestFile('example.R')
		editor.selection = new vscode.Selection(7, 6, 7, 6)
		await vscode.commands.executeCommand('vscode-flowr.slice.cursor-reconstruct')

		const newDoc = vscode.window.activeTextEditor?.document
		assert.ok(newDoc)
		assert.ok(newDoc.fileName.startsWith('Untitled-'))
		assert.equal(newDoc.getText(), `
product <- 1
n <- 10
for(i in 1:(n - 1)) product <- product * i
			`.trim())
	})
})
