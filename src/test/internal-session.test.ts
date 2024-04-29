import * as assert from 'assert'
import * as vscode from 'vscode'
import { establishInternalSession, flowrSession } from '../extension'

suite('Internal session', () => {
	test('Startup internal session', async() => {
		const ext = vscode.extensions.getExtension('code-Inspect.vscode-flowr')
		await ext?.activate()

		// TODO this doesn't work yet because the activated extension is not the same as the imported code ...???
		assert.equal(flowrSession, undefined, 'flowr session should be undefined on startup')
		await establishInternalSession()
		assert.equal(flowrSession?.state, 'active', 'flowr session should be active after establishing')
	})
})
