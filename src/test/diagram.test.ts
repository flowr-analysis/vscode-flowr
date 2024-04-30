import * as vscode from 'vscode'
import * as assert from 'assert'

import { activateExtension, openTestFile } from './test-util'

suite('diagram', () => {
	suiteSetup(async() => {
		await activateExtension()
	})

	test('dataflow', async() => {
		await openTestFile('simple-example.R')
		const result: {webview: vscode.WebviewPanel, mermaid: string} | undefined =
			await vscode.commands.executeCommand('vscode-flowr.dataflow')
		assert.ok(result)
		assert.equal(result.webview.title, 'Dataflow Graph')
		assert.equal(result.mermaid, `
flowchart TD
	%% 0: {"current":{"name":".GlobalEnv","id":"140","memory":[["return",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"return","nodeId":"built-in"}]],["cat",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"cat","nodeId":"built-in"}]],["print",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"print","nodeId":"built-in"}]],["source",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"source","nodeId":"built-in"}]]]},"level":0}
	0["\`X (0, *local*)
	  *1.1-1.1*\`"]
	%% 3: {"current":{"name":".GlobalEnv","id":"144","memory":[["return",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"return","nodeId":"built-in"}]],["cat",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"cat","nodeId":"built-in"}]],["print",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"print","nodeId":"built-in"}]],["source",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"source","nodeId":"built-in"}]],["X",[{"nodeId":"0","scope":"local","name":"X","used":"always","kind":"variable","definedAt":"2"}]]]},"level":0}
	3["\`Y (3, *local*)
	  *2.1-2.1*\`"]
	%% 4: {"current":{"name":".GlobalEnv","id":"145","memory":[["return",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"return","nodeId":"built-in"}]],["cat",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"cat","nodeId":"built-in"}]],["print",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"print","nodeId":"built-in"}]],["source",[{"kind":"built-in-function","scope":".GlobalEnv","used":"always","definedAt":"built-in","name":"source","nodeId":"built-in"}]],["X",[{"nodeId":"0","scope":"local","name":"X","used":"always","kind":"variable","definedAt":"2"}]]]},"level":0}
	4(["\`X (4)
	  *2.6-2.6*\`"])
	3 -->|"defined-by (always)"| 4
	4 -->|"reads (always)"| 0
		`.replaceAll('\t', '    ').trim())
	})
})

