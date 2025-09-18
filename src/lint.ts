import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import type { LintingRuleConfig, LintingRuleMetadata, LintingRuleNames, LintingRuleResult } from '@eagleoutice/flowr/linter/linter-rules';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import { getConfig, LinterRefresherConfigKeys, Settings } from './settings';
import type { ConfiguredLintingRule, LintingResult, LintQuickFix } from '@eagleoutice/flowr/linter/linter-format';
import { ConfigurableRefresher } from './configurable-refresher';
import type { LinterQueryResult } from '@eagleoutice/flowr/queries/catalog/linter-query/linter-query-format';
import { rangeToVscodeRange } from './flowr/utils';
import { rangeCompare } from '@eagleoutice/flowr/util/range';

export function registerLintCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const linter = new LinterService(context, output);
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.lint.run', async() => {
		await linter.updateDiagnostics();
	}));
}

class CodeAction extends vscode.CodeAction {

	public readonly document:   vscode.TextDocument;
	public readonly quickFixes: LintQuickFix[];

	constructor(document: vscode.TextDocument, quickFixes: LintQuickFix[]) {
		super([...new Set<string>(quickFixes.map(q => q.description))].join(', '), vscode.CodeActionKind.QuickFix);
		this.document = document;
		this.quickFixes = quickFixes;
	}
}

class LinterService implements vscode.CodeActionProvider<CodeAction> {
	private readonly output: vscode.OutputChannel;
	private readonly diagnosticCollection = vscode.languages.createDiagnosticCollection('flowr-lint');
	private readonly codeActions = vscode.languages.registerCodeActionsProvider({ language: 'r' }, this, {
		providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
	});
	private readonly refresher:      ConfigurableRefresher;
	private readonly resultsPerFile: Map<vscode.Uri, LinterQueryResult> = new Map<vscode.Uri, LinterQueryResult>();

	constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
		this.output = output;
		this.refresher = new ConfigurableRefresher({
			name:            'Lint',
			keys:            LinterRefresherConfigKeys,
			refreshCallback: async() => {
				await this.updateDiagnostics();
			},
			output: output
		});
		context.subscriptions.push(this.diagnosticCollection, this.codeActions, this.refresher);
	}

	async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, _context: vscode.CodeActionContext, _token: vscode.CancellationToken): Promise<(CodeAction | vscode.Command)[]> {
		const ret: CodeAction[] = [];
		const results = await this.lintFile(document);
		for(const findings of Object.values(results.results)) {
			if('error' in findings) {
				continue;
			}
			for(const finding of findings.results) {
				const quickFixes = (finding as LintingResult).quickFix;
				if(!quickFixes?.length){
					continue;
				}
				// only add quick fixes if we overlap the relevant rnage or selection
				if([...quickFixes.map(q => q.range), finding.range].some(r => rangeToVscodeRange(r).intersection(range))) {
					ret.push(new CodeAction(document, quickFixes));
				}
			}
		}
		return ret;
	}

	resolveCodeAction(codeAction: CodeAction, _token: vscode.CancellationToken): vscode.ProviderResult<CodeAction> {
		codeAction.edit = new vscode.WorkspaceEdit();
		for(const fix of codeAction.quickFixes.sort((f1, f2) => rangeCompare(f2.range, f1.range))) {
			const range = rangeToVscodeRange(fix.range);
			switch(fix.type) {
				case 'replace':
					codeAction.edit.replace(codeAction.document.uri, range, fix.replacement);
					break;
				case 'remove':
					codeAction.edit.delete(codeAction.document.uri, range);
					break;
				default:
					vscode.window.showWarningMessage(`The quick fix type ${(fix as LintQuickFix).type} is not yet supported by this extension`);
			}	
		}
		return codeAction;
	}

	async lintFile(document: vscode.TextDocument, forceRefresh: boolean = false): Promise<LinterQueryResult> {
		if(!forceRefresh) {
			const results = this.resultsPerFile.get(document.uri);
			if(results !== undefined) {
				this.output.appendLine(`[Lint] Using cached results for document ${document.fileName}`);
				return results;
			}
		}
		
		this.output.appendLine(`[Lint] Analyzing document ${document.fileName}`);
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

		const lint = await session.retrieveQuery(document, [{ 
			type:  'linter',
			rules: rules
		}]);
		this.resultsPerFile.set(document.uri, lint.result.linter);

		return lint.result.linter;
	}

	async updateDiagnostics(): Promise<void> {
		const activeEditor = vscode.window.activeTextEditor;
		if(!activeEditor) {
			return;
		}

		const results = await this.lintFile(activeEditor.document, true);
		const diagnostics: vscode.Diagnostic[] = [];
		for(const [ruleName, findings] of Object.entries(results.results)) {
			if('error' in findings) {
				continue;
			}
			const rule = LintingRules[ruleName as LintingRuleNames];

			this.output.appendLine(`[Lint] Found ${findings.results.length} issues for rule ${ruleName}`);
			this.output.appendLine(`[Lint] ${JSON.stringify(findings)}`);

			for(const result of findings.results) {
				// not all linting results have a range
				if(result.range === undefined) {
					continue;
				}
				const range = rangeToVscodeRange(result.range);
				const diag = new vscode.Diagnostic(
					range,
					`${ruleName}: ${(rule.prettyPrint['full'] as (result: LintingRuleResult<LintingRuleNames>, metadata: LintingRuleMetadata<LintingRuleNames>) => string)(
							result as LintingRuleResult<LintingRuleNames>,
							result as LintingRuleMetadata<LintingRuleNames>
					)}`,
					vscode.DiagnosticSeverity.Warning
				);
				diag.source = this.diagnosticCollection.name;
				diag.code = {
					value:  ruleName,
					target: vscode.Uri.parse(`https://github.com/flowr-analysis/flowr/wiki/lint-${ruleName}`)
				};
				diagnostics.push(diag);
			}
		}
		this.diagnosticCollection.set(activeEditor.document.uri, diagnostics);
	}
}
