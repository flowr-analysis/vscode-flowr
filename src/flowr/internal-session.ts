import * as vscode from 'vscode';
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, VSCodeFlowrConfiguration, getWasmRootPath, isWeb, updateStatusBar } from '../extension';
import { Settings , getConfig, isVerbose } from '../settings';
import { graphToMermaid } from '@eagleoutice/flowr/util/mermaid/dfg';
import type { FlowrSession, SliceReturn } from './utils';
import { makeSliceElements } from './utils';
import type { RShellOptions } from '@eagleoutice/flowr/r-bridge/shell';
import { RShell, RShellReviveOptions } from '@eagleoutice/flowr/r-bridge/shell';
import { normalizedAstToMermaid } from '@eagleoutice/flowr/util/mermaid/ast';
import { cfgToMermaid } from '@eagleoutice/flowr/util/mermaid/cfg';
import type { KnownParser, KnownParserName } from '@eagleoutice/flowr/r-bridge/parser';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { type Queries, type QueryResults, type SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { SemVer } from 'semver';
import { repl, type FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import { versionReplString } from '@eagleoutice/flowr/cli/repl/print-version';
import { LogLevel, log } from '@eagleoutice/flowr/util/log';
import { staticSlice } from '@eagleoutice/flowr/slicing/static/static-slicer';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import { reconstructToCode } from '@eagleoutice/flowr/reconstruct/reconstruct';
import { doNotAutoSelect } from '@eagleoutice/flowr/reconstruct/auto-select/auto-select-defaults';
import { makeMagicCommentHandler } from '@eagleoutice/flowr/reconstruct/auto-select/magic-comments';
import { getEngineConfig } from '@eagleoutice/flowr/config';
import type { SliceDirection } from '@eagleoutice/flowr/core/steps/all/static-slicing/00-slice';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import { extractCfgQuick } from '@eagleoutice/flowr/control-flow/extract-cfg';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import type { PipelinePerStepMetaInformation } from '@eagleoutice/flowr/core/steps/pipeline/pipeline';
import { FlowrInlineTextFile } from '@eagleoutice/flowr/project/context/flowr-file';
import type { FlowrAnalyzer } from '@eagleoutice/flowr/project/flowr-analyzer';

const logLevelToScore = {
	Silly: LogLevel.Silly,
	Trace: LogLevel.Trace,
	Debug: LogLevel.Debug,
	Info:  LogLevel.Info,
	Warn:  LogLevel.Warn,
	Error: LogLevel.Error,
	Fatal: LogLevel.Fatal
} as const;

function setFlowrLoggingSensitivity(output: vscode.OutputChannel) {
	const desired = getConfig().get<keyof typeof logLevelToScore>(Settings.DebugFlowrLoglevel, isVerbose() ? 'Info' : 'Fatal');
	const level = desired in logLevelToScore ? logLevelToScore[desired] : LogLevel.Info;

	output.appendLine('[flowR] Setting log level to ' + desired + ' (' + level + ')');

	log.updateSettings(l => {
		l.settings.minLevel = level;
		// disable all formatting highlights
		l.settings.type = 'json';
		if(isVerbose()) {
			// redirect console.log to output channel
			let lastMessage = '';
			l.attachTransport(l => {
				const level = l._meta?.logLevelName ?? 'LEVEL?';
				const date = l._meta?.date ? l._meta.date.toUTCString() : 'TIME?';
				let msg = l['0'] as unknown as string | (() => string);
				if(typeof msg === 'function') {
					msg = msg();
				}
				const message = '[flowR, ' + date + ', ' + level + '] ' + msg;
				if(lastMessage !== message) {
					output.appendLine(message);
					lastMessage = message;
				}
			});
		}
	});
}


function configureFlowrLogging(output: vscode.OutputChannel) {
	vscode.workspace.onDidChangeConfiguration(e => {
		if(!e.affectsConfiguration(Settings.Category)) {
			return;
		}
		setFlowrLoggingSensitivity(output);
	});
	setFlowrLoggingSensitivity(output);
}

export class FlowrInternalSession implements FlowrSession {

	private static treeSitterInitialized: boolean = false;

	public state:    'inactive' | 'loading' | 'active' | 'failure';
	public rVersion: string | undefined;
	public working:  boolean = false;
	public parser:   KnownParser | undefined;

	private readonly outputChannel: vscode.OutputChannel;

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.state = 'inactive';
		configureFlowrLogging(this.outputChannel);
		updateStatusBar();
	}

	private async workingOn<T = void>(document: vscode.TextDocument, actionFn: (analyzer: FlowrAnalyzer) => Promise<T>, action: string, showErrorMessage: boolean, defaultOnErr = {} as T): Promise<T> {
		if(!this.parser) {
			return defaultOnErr;
		}
		
		const analyzer = await analyzerFromDocument(document, this.parser);		

		// update the vscode ui
		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title:    (() => {
				switch(action) {
					case 'slice': return 'Creating Slice...';
					case 'ast':   return 'Creating AST...';
					case 'cfg':   return 'Creating Control Flow Graph...';
					case 'dfg':   return 'Creating Data Flow Graph...';
					default:      return 'Working...';
				}
			})(),
			cancellable: false
		},
		() => {
			this.setWorking(true);
			return actionFn(analyzer).catch(e => {
				this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
				(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l));
				if(showErrorMessage) {
					void vscode.window.showErrorMessage(`There was an error: ${(e as Error)?.message}. See the flowR output for more information.`);
				}
				return defaultOnErr;
			}).finally(() => {
				this.setWorking(false);
			});
		});
	}

	setWorking(working: boolean): void {
		this.working = working;
		updateStatusBar();
	}

	async initialize() {
		this.state = 'loading';
		updateStatusBar();
		this.outputChannel.appendLine('Starting internal flowR engine');

		switch(FlowrInternalSession.getEngineToUse()) {
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

				this.parser = new RShell(getEngineConfig(VSCodeFlowrConfiguration, 'r-shell'), options);
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
						const timeout = getConfig().get<number>(Settings.TreeSitterTimeout, 60000);

						this.outputChannel.appendLine('Initializing tree-sitter... (wasm at: ' + getWasmRootPath() + ', timeout: ' + timeout + 'ms)');

						await Promise.race([TreeSitterExecutor.initTreeSitter(
							getEngineConfig(VSCodeFlowrConfiguration, 'tree-sitter'),
						), new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Timeout (${Settings.TreeSitterTimeout} = ${timeout}ms)`)), timeout))]);
						FlowrInternalSession.treeSitterInitialized = true;
					} catch(e) {
						this.outputChannel.appendLine('Error in init of tree sitter: ' + (e as Error)?.message);
						this.outputChannel.appendLine((e as Error)?.stack ?? '');
						vscode.window.showErrorMessage('Failed to initialize tree-sitter. See the flowR output for more information.');
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

	async retrieveSlice(criteria: SlicingCriteria, direction: SliceDirection, document: vscode.TextDocument, showErrorMessage: boolean = true, info?: { dfi: DataflowInformation, ast: NormalizedAst }): Promise<SliceReturn> {
		if(!this.parser) {
			return {
				code:          '',
				sliceElements: []
			};
		}
		return await this.workingOn(document, async() => await this.extractSlice(document, criteria, direction, info), 'slice', showErrorMessage, { code: '', sliceElements: [] });
	}

	async retrieveDataflowMermaid(document: vscode.TextDocument, simplified = false): Promise<string> {
		if(!this.parser) {
			return '';
		}

		return await this.workingOn(document, async(analyzer) => {
			const result = await analyzer.dataflow();
			return graphToMermaid({ graph: result.graph, simplified, includeEnvironments: false }).string;
		}, 'dfg', true);
	}

	async retrieveAstMermaid(document: vscode.TextDocument): Promise<string> {
		return await this.workingOn(document, async(analyzer) => {
			const result = await analyzer.normalize();
			return normalizedAstToMermaid(result.ast);
		}, 'ast', true);
	}

	async retrieveCfgMermaid(document: vscode.TextDocument): Promise<string> {
		return await this.workingOn(document, async(analyzer) => {
			const result = await analyzer.normalize();
			return cfgToMermaid(extractCfgQuick(result), result);
		}, 'cfg', true);
	}

	private async extractSlice(document: vscode.TextDocument, criteria: SlicingCriteria, direction: SliceDirection, info?: { dfi: DataflowInformation, ast: NormalizedAst }): Promise<SliceReturn> {
		if(!this.parser) {
			return {
				code:          '',
				sliceElements: []
			};
		}

		const analyzer = await analyzerFromDocument(document, this.parser);
		const threshold = getConfig().get<number>(Settings.SliceRevisitThreshold, 12);
		if(!info) {
			this.outputChannel.appendLine(`[Slice (Internal)] Slicing using pipeline (threshold: ${threshold})`);
			const dataflow = await analyzer.dataflow();
			const ast = await analyzer.normalize();
			info = {
				dfi: dataflow,
				ast: ast
			};
		} else {
			this.outputChannel.appendLine(`[Slice (Internal)] Re-Slice using existing dataflow Graph and AST (threshold: ${threshold})`);
		}

		const now = Date.now();
		const elements = staticSlice(analyzer.inspectContext(), info.dfi, info.ast, criteria, direction, threshold).result;
		const sliceTime = Date.now() - now;
		const sliceElements = makeSliceElements(elements, id => info.ast.idMap.get(id)?.location);
		const reconstructNow = Date.now();
		const code = reconstructToCode(info.ast, { nodes: new Set(elements) }, makeMagicCommentHandler(doNotAutoSelect)).code;
		this.outputChannel.appendLine('[Slice (Internal)] Slice took ' + (Date.now() - now) + 'ms (slice: ' + sliceTime + 'ms, reconstruct: ' + (Date.now() - reconstructNow) + 'ms)');
		
		if(isVerbose()) {
			this.outputChannel.appendLine('[Slice (Internal)] Contains Ids: ' + JSON.stringify([...elements]));
		}

		return {
			code,
			sliceElements
		};
	}

	public async retrieveQuery<T extends SupportedQueryTypes>(document: vscode.TextDocument, query: Queries<T>): Promise<{ result: QueryResults<T>, hasError: boolean, dfi?: DataflowInformation, ast?: NormalizedAst }> {
		if(!this.parser) {
			throw new Error('No parser available');
		}

		const analyzer = await analyzerFromDocument(document, this.parser);
		const dataflow = await analyzer.dataflow() as DataflowInformation & PipelinePerStepMetaInformation;
		const normalize = await analyzer.normalize();
		
		if(normalize.hasError && (normalize.ast.files as unknown[])?.length === 0) {
			return { result: {} as QueryResults<T>, hasError: true, dfi: dataflow, ast: normalize };
		}

		return {
			result:   await analyzer.query(query),
			hasError: normalize.hasError ?? false,
			dfi:      dataflow,
			ast:      normalize
		};
	}

	public async runRepl(config: Omit<Required<FlowrReplOptions>, 'parser'>) {
		if(!this.parser) {
			return;
		}
		const analyzer = await new FlowrAnalyzerBuilder()
			.setParser(this.parser)
			.setConfig(VSCodeFlowrConfiguration)
			.build();
		(config.output as { stdout: (s: string) => void}).stdout(await versionReplString(this.parser));
		await repl({ analyzer: analyzer });
	}

	public static getEngineToUse(): KnownParserName {
		return isWeb() ? 'tree-sitter' : getConfig().get<KnownParserName>(Settings.Rengine, 'tree-sitter');
	}
}

async function analyzerFromDocument(document: vscode.TextDocument, parser: KnownParser): Promise<FlowrAnalyzer> {
	const analyzer = await new FlowrAnalyzerBuilder()
		.setParser(parser)
		.setConfig(VSCodeFlowrConfiguration)
		.build();

	const file = new FlowrInlineTextFile(document.fileName, document.getText());
	analyzer.reset();
	analyzer.addFile(file);
	analyzer.addRequest(`file://${document.fileName}`);

	return analyzer;
}
