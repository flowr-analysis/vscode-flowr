import assert from 'assert';
import * as vscode from 'vscode';
import { mcpServerCommand } from '../mcp';
import { getConfig, Settings } from '../settings';

suite('mcp', () => {
	test('contributes flowR as an MCP server provider and a setting to turn it off', () => {
		const contributes = (vscode.extensions.getExtension('code-inspect.vscode-flowr')?.packageJSON as {
			contributes: { mcpServerDefinitionProviders: { id: string }[], configuration: { properties: Record<string, { default: unknown }> } }
		}).contributes;
		assert.ok(contributes.mcpServerDefinitionProviders.some(p => p.id === 'vscode-flowr.mcp'));
		assert.strictEqual(contributes.configuration.properties['vscode-flowr.mcp.enabled'].default, true);
	});

	test('starts the pinned flowR MCP server with npx by default', () => {
		const server = mcpServerCommand();
		assert.strictEqual(server?.command, 'npx');
		assert.ok(server.args.some(a => /^@eagleoutice\/flowr-mcp@\d+\.\d+\.\d+$/.test(a)), `expected a pinned package, got ${server.args.join(' ')}`);
	});

	test('offers nothing once turned off', async() => {
		const config = getConfig();
		const before = config.inspect<boolean>(Settings.McpEnabled)?.globalValue;
		try {
			await config.update(Settings.McpEnabled, false, vscode.ConfigurationTarget.Global);
			assert.strictEqual(mcpServerCommand(), undefined);
		} finally {
			await config.update(Settings.McpEnabled, before, vscode.ConfigurationTarget.Global);
		}
	});
});
