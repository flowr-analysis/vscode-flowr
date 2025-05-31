import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { LintingRuleNames, LintingRuleResult, LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import { FilePathValidityResult } from '@eagleoutice/flowr/linter/rules/2-file-path-validity';
import { DeprecatedFunctionsResult } from '@eagleoutice/flowr/linter/rules/1-deprecated-functions';

export function registerLintCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
   const linter = new LinterService(output);
   context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.lint.run', async() => {
      await linter.runLinting()
   }));
}

class LinterService {
   private readonly output: vscode.OutputChannel;
   private readonly collection = vscode.languages.createDiagnosticCollection('flowr-lint');

   constructor(output: vscode.OutputChannel) {
      this.output = output;
   }
   
   async runLinting(): Promise<void> {
      const activeEditor = vscode.window.activeTextEditor;

      if (!activeEditor) {
         return;
      }
   
      const diagnostics: vscode.Diagnostic[] = [];
      this.output.appendLine(`[Lint] Analyzing document: ${activeEditor.document.fileName}`);
      const session = await getFlowrSession();
      
      const lint = await session.retrieveQuery(activeEditor.document, [{ type: 'linter' }]);
      
      for(const [ruleName, findings] of Object.entries(lint.result.linter.results)) {
         const rule = LintingRules[ruleName as LintingRuleNames];

         this.output.appendLine(`[Lint] Found ${findings.results.length} issues for rule: ${ruleName}`);
         this.output.appendLine(`[Lint] ${JSON.stringify(findings)}`);
         
         for(const finding of findings.results) {
            const range = new vscode.Range(
               finding.range[0] - 1,
               finding.range[1] - 1,
               finding.range[2] - 1,
               finding.range[3] - 1
            );
            diagnostics.push(
               new vscode.Diagnostic(
                  range,
                  ruleName + ': ' + rule.prettyPrint(finding as LintingRuleResult<LintingRuleNames>),
                  vscode.DiagnosticSeverity.Warning
               )
            );
         }
      }

      this.collection.set(activeEditor.document.uri, diagnostics);
   }
}