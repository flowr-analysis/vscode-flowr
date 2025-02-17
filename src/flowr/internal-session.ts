import * as vscode from 'vscode';
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, getConfig, getWasmRootPath, isVerbose, updateStatusBar } from '../extension';
import { Settings } from '../settings';
import { dataflowGraphToMermaid } from '@eagleoutice/flowr/core/print/dataflow-printer';
import { extractCFG } from '@eagleoutice/flowr/util/cfg/cfg';
import type { FlowrSession, SliceReturn } from './utils';
import { consolidateNewlines, makeSliceElements } from './utils';
import type { RShellOptions } from '@eagleoutice/flowr/r-bridge/shell';
import { RShell, RShellReviveOptions } from '@eagleoutice/flowr/r-bridge/shell';
import { createDataflowPipeline, createNormalizePipeline, createSlicePipeline } from '@eagleoutice/flowr/core/steps/pipeline/default-pipelines';
import { requestFromInput } from '@eagleoutice/flowr/r-bridge/retriever';
import { normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid/ast';
import { cfgToMermaid } from '@eagleoutice/flowr/util/mermaid/cfg';
import type { KnownParser, KnownParserName } from '@eagleoutice/flowr/r-bridge/parser';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import type { Queries, QueryResults, SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import { executeQueries } from '@eagleoutice/flowr/queries/query';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { SemVer } from 'semver';
import { repl, type FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import { versionReplString } from '@eagleoutice/flowr/cli/repl/print-version';
import { amendConfig } from '@eagleoutice/flowr/config';

export class FlowrInternalSession implements FlowrSession {
	
	private static treeSitterInitialized: boolean = false;

	public state:    'inactive' | 'loading' | 'active' | 'failure';
	public rVersion: string | undefined;
	public	working:  boolean = false;
	public parser:   KnownParser | undefined;

	private readonly outputChannel: vscode.OutputChannel;
	private readonly forcedEngine:  KnownParserName | undefined;

	constructor(outputChannel: vscode.OutputChannel, forcedEngine: KnownParserName | undefined) {
		this.outputChannel = outputChannel;
		this.forcedEngine = forcedEngine;

		this.state = 'inactive';
		updateStatusBar();
	}

	private async workingOnSlice<T = void>(shell: KnownParser, fun: (shell: KnownParser) => Promise<T>): Promise<T> {
		try {
			this.setWorking(true);
			return fun(shell);
		} finally {
			this.setWorking(false);
		}
	}

	setWorking(working: boolean): void {
		this.working = working;
		updateStatusBar();
	}

	async initialize() {
		this.state = 'loading';
		updateStatusBar();

		this.outputChannel.appendLine('Starting internal flowR engine');

		switch(this.forcedEngine ?? getConfig().get<KnownParserName>(Settings.Rengine)) {
			case 'r-shell': {
				let options: Partial<RShellOptions> = {
					revive:      RShellReviveOptions.Always,
					sessionName: 'flowr - vscode'
				};
				const executable = getConfig().get<string>(Settings.Rexecutable)?.trim();
				if(executable !== undefined && executable.length > 0) {
					options = { ...options, pathToRExecutable: executable };
				}
				this.outputChannel.appendLine(`Using options ${JSON.stringify(options)}`);
				
				this.parser = new RShell(options);
				this.parser.tryToInjectHomeLibPath();

				// wait at most 1 second for the version, since the R shell doesn't let us know if the path
				// we provided doesn't actually lead anywhere, or doesn't contain an R executable, etc.
				let handle: NodeJS.Timeout;
				const timeout = new Promise<null>(resolve => handle = setTimeout(() => resolve(null), 5000));
				await Promise.race([this.parser.usedRVersion(), timeout]).then((version: SemVer | null) => {
					clearTimeout(handle);
					if(!version){
						const seeDoc = 'See documentation';
						void vscode.window.showErrorMessage('The R version could not be determined. R needs to be installed and part of your PATH environment variable.', seeDoc)
							.then(s => {
								if(s === seeDoc){
									void vscode.env.openExternal(vscode.Uri.parse('https://github.com/flowr-analysis/vscode-flowr/blob/main/README.md#using'));
								}
							});

						this.state = 'failure';
						updateStatusBar();
					} else {
						this.outputChannel.appendLine(`Using R version ${version.toString()}`);
						if(version.major < MINIMUM_R_MAJOR) {
							void vscode.window.showErrorMessage(`You are using R version ${version.toString()}, but ${MINIMUM_R_MAJOR}.0.0 or higher is required.`);
						} else if(version.major < BEST_R_MAJOR) {
							void vscode.window.showWarningMessage(`You are using R version ${version.toString()}, which flowR has not been tested for. Version ${BEST_R_MAJOR}.0.0 or higher is recommended.`);
						}

						this.state = 'active';
						this.rVersion = version.toString();
						updateStatusBar();
					}
				});
				break;
			}
			case 'tree-sitter': {
				if(!FlowrInternalSession.treeSitterInitialized) {
					try {
						const root = getWasmRootPath();
						this.outputChannel.appendLine('Initializing tree-sitter... (wasm at: ' + root + ')');
						amendConfig({ engines: [{
							type:               'tree-sitter',
							wasmPath:           `${root}/tree-sitter-r.wasm`,
							treeSitterWasmPath: `${root}/tree-sitter.wasm`
						}] });
						
						await TreeSitterExecutor.initTreeSitter();
						FlowrInternalSession.treeSitterInitialized = true;
					} catch(e) {
						this.outputChannel.appendLine('Error in init: ' + (e as Error)?.message);
					}
				}
				this.outputChannel.appendLine('Tree-sitter loaded!');

				this.parser = new TreeSitterExecutor();
				this.outputChannel.appendLine('Tree-sitter initialized!');
				
				this.state = 'active';
				this.rVersion = await this.parser.rVersion();
				updateStatusBar();
			}
		}
	}

	public destroy(): void {
		this.parser?.close();
	}

	async retrieveSlice(criteria: SlicingCriteria, document: vscode.TextDocument, showErrorMessage: boolean = true): Promise<SliceReturn> {
		if(!this.parser) {
			return {
				code:          '',
				sliceElements: []
			};
		}
		try {
			return await this.workingOnSlice(this.parser, async() => await this.extractSlice(document, criteria));
		} catch(e) {
			this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
			(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l));
			if(showErrorMessage){
				void vscode.window.showErrorMessage(`There was an error while extracting a slice: ${(e as Error)?.message}. See the flowR output for more information.`);
			}
			return {
				code:          '',
				sliceElements: []
			};
		}
	}

	async retrieveDataflowMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.parser) {
			return '';
		}
		const result = await createDataflowPipeline(this.parser, {
			request: requestFromInput(consolidateNewlines(document.getText()))
		}).allRemainingSteps();
		return dataflowGraphToMermaid(result.dataflow);
	}

	async retrieveAstMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.parser) {
			return '';
		}
		return await this.workingOnSlice(this.parser, async s => {
			const result = await createNormalizePipeline(s, {
				request: requestFromInput(consolidateNewlines(document.getText()))
			}).allRemainingSteps();
			return normalizedAstToMermaid(result.normalize.ast);
		});
	}

	async retrieveCfgMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.parser) {
			return '';
		}
		return await this.workingOnSlice(this.parser, async s => {
			const result = await createNormalizePipeline(s, {
				request: requestFromInput(consolidateNewlines(document.getText()))
			}).allRemainingSteps();
			return cfgToMermaid(extractCFG(result.normalize), result.normalize);
		});
	}

	private async extractSlice(document: vscode.TextDocument, criteria: SlicingCriteria): Promise<SliceReturn> {
		const content = consolidateNewlines(document.getText());

		const slicer = createSlicePipeline(this.parser as KnownParser, {
			criterion: criteria,
			request:   requestFromInput(content)
		});
		const result = await slicer.allRemainingSteps();

		const sliceElements = makeSliceElements(result.slice.result, id => result.normalize.idMap.get(id)?.location);

		if(isVerbose()) {
			this.outputChannel.appendLine('slice: ' + JSON.stringify([...result.slice.result]));
		}
		return {
			code: result.reconstruct.code,
			sliceElements
		};
	}
	
	public async retrieveQuery<T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>): Promise<QueryResults<T>> {
		if(!this.parser) {
			throw new Error('No parser available');
		}
		const result = await createDataflowPipeline(this.parser, {
			request: requestFromInput(consolidateNewlines(document.getText()))
		}).allRemainingSteps();
		return executeQueries({ ast: result.normalize, dataflow: result.dataflow }, query);
	}
	
	public async runRepl(config: Omit<Required<FlowrReplOptions>, 'parser'>) {
		if(!this.parser) {
			return;
		}
		(config.output as { stdout: (s: string) => void}).stdout(await versionReplString(this.parser));
		await repl({ ...config, parser: this.parser });
	}
}
