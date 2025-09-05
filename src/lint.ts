import * as vscode from 'vscode';
import { getConfig, getFlowrSession } from './extension';
import type { LintingRuleConfig, LintingRuleMetadata, LintingRuleNames, LintingRuleResult } from '@eagleoutice/flowr/linter/linter-rules';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import { LinterRefresherConfigKeys, Settings } from './settings';
import type { ConfiguredLintingRule } from '@eagleoutice/flowr/linter/linter-format';
import { ConfigurableRefresher } from './configurable-refresher';

export function registerLintCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const linter = new LinterService(output);
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.lint.run', async() => {
		await linter.runLinting();
	}));
}

class LinterService {
	private readonly output: vscode.OutputChannel;
	private readonly collection = vscode.languages.createDiagnosticCollection('flowr-lint');

	private readonly refresher: ConfigurableRefresher;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
		this.refresher = new ConfigurableRefresher({
			name:            'Lint',
			keys:            LinterRefresherConfigKeys,
			refreshCallback: async() => {
				await this.runLinting();
			},
			output: output
		});
	}

	async runLinting(): Promise<void> {
		const activeEditor = vscode.window.activeTextEditor;

		if(!activeEditor) {
			return;
		}

		const diagnostics: vscode.Diagnostic[] = [];
		this.output.appendLine(`[Lint, Preview] Analyzing document: ${activeEditor.document.fileName}`);
		const session = await getFlowrSession();

		// rules are only enabled if they're contained in the enabledRules config
		let rules: (LintingRuleNames | ConfiguredLintingRule)[] = getConfig().get<LintingRuleNames[]>(Settings.LinterEnabledRules, []);
		// empty array means all rules should be enabled (we do it like this so we can apply configs)
		if(rules.length <= 0) {
			rules = Object.keys(LintingRules) as LintingRuleNames[];
		}
		// now we apply the ruleConfigs to all enabled rules
		for(const [ruleName, config] of Object.entries(getConfig().get<{[N in LintingRuleNames]?: LintingRuleConfig<N>}>(Settings.LinterRuleConfigs, {}))) {
			const index = rules.indexOf(ruleName as LintingRuleNames);
			if(index >= 0) {
				rules[index] = { 
					name:   ruleName as LintingRuleNames, 
					config: config as LintingRuleConfig<LintingRuleNames>
				};
			}
		}
		this.output.appendLine(`[Lint] Using rules ${JSON.stringify(rules)}`);

		const lint = await session.retrieveQuery(activeEditor.document, [{ 
			type:  'linter',
			rules: rules
		}]);

		for(const [ruleName, findings] of Object.entries(lint.result.linter.results)) {
			if('error' in findings) {
				continue;
			}
			const rule = LintingRules[ruleName as LintingRuleNames];

			this.output.appendLine(`[Lint] Found ${findings.results.length} issues for rule: ${ruleName}`);
			this.output.appendLine(`[Lint] ${JSON.stringify(findings)}`);

			for(const result of findings.results) {
				// not all linting results have a range
				if(result.range === undefined) {
					continue;
				}
				const range = new vscode.Range(
					result.range[0] - 1,
					result.range[1] - 1,
					result.range[2] - 1,
					result.range[3]
				);
				diagnostics.push(
					new vscode.Diagnostic(
						range,
						ruleName + ': ' + (rule.prettyPrint['full'] as (result: LintingRuleResult<LintingRuleNames>, metadata: LintingRuleMetadata<LintingRuleNames>) => string)(
							result as LintingRuleResult<LintingRuleNames>,
							result as LintingRuleMetadata<LintingRuleNames>
						),
						vscode.DiagnosticSeverity.Warning
					)
				);
			}
		}

		this.collection.set(activeEditor.document.uri, diagnostics);
	}
}
