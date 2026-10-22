import * as vscode from 'vscode';
import { getConfig, Settings } from './settings';
import { isWeb } from './extension';

/** flowR's MCP server, pinned like the flowR it ships with; its own flowR and signature database are not the extension's */
const McpPackage = '@eagleoutice/flowr-mcp@0.1.3';
const McpProviderId = 'vscode-flowr.mcp';

/** how to start flowR's MCP server, `undefined` if it is turned off */
export function mcpServerCommand(): { command: string, args: string[] } | undefined {
	return getConfig().get<boolean>(Settings.McpEnabled, true)
		? { command: 'npx', args: ['-y', '--omit=optional', '--ignore-scripts', McpPackage] }
		: undefined;
}

/** offers flowR's MCP server (the `query` tool) to the editor's MCP clients; needs a VS Code with the MCP API and a desktop with `npx` */
export function registerMcpServer(): vscode.Disposable {
	if(isWeb() || !vscode.lm?.registerMcpServerDefinitionProvider) {
		return new vscode.Disposable(() => undefined);
	}
	const changed = new vscode.EventEmitter<void>();
	const provider = vscode.lm.registerMcpServerDefinitionProvider(McpProviderId, {
		onDidChangeMcpServerDefinitions: changed.event,
		provideMcpServerDefinitions:     () => {
			const server = mcpServerCommand();
			return server ? [new vscode.McpStdioServerDefinition('flowR', server.command, server.args)] : [];
		}
	});
	const config = vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(Settings.Category)) {
			changed.fire();
		}
	});
	return vscode.Disposable.from(provider, config, changed);
}
