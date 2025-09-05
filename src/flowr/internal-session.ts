import * as vscode from 'vscode';
import { BEST_R_MAJOR, MINIMUM_R_MAJOR, VSCodeFlowrConfiguration, getConfig, getWasmRootPath, isVerbose, isWeb, updateStatusBar } from '../extension';
import { Settings } from '../settings';
import { graphToMermaid } from '@eagleoutice/flowr/util/mermaid/dfg';
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
import { executeQueries, type Queries, type QueryResults, type SupportedQueryTypes } from '@eagleoutice/flowr/queries/query';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { SemVer } from 'semver';
import { repl, type FlowrReplOptions } from '@eagleoutice/flowr/cli/repl/core';
import { versionReplString } from '@eagleoutice/flowr/cli/repl/print-version';
import { LogLevel, log } from '@eagleoutice/flowr/util/log';
import { staticSlice } from '@eagleoutice/flowr/slicing/static/static-slicer';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { reconstructToCode } from '@eagleoutice/flowr/reconstruct/reconstruct';
import { doNotAutoSelect } from '@eagleoutice/flowr/reconstruct/auto-select/auto-select-defaults';
import { makeMagicCommentHandler } from '@eagleoutice/flowr/reconstruct/auto-select/magic-comments';
import { getEngineConfig } from '@eagleoutice/flowr/config';
import type { SliceDirection } from '@eagleoutice/flowr/core/steps/all/static-slicing/00-slice';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import { extractCfgQuick } from '@eagleoutice/flowr/control-flow/extract-cfg';

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

	private async workingOn<T = void>(shell: KnownParser, fun: (shell: KnownParser) => Promise<T>, action: string): Promise<T> {
		this.setWorking(true);
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
			return fun(shell).catch(e => {
				this.outputChannel.appendLine('Error: ' + (e as Error)?.message);
				(e as Error).stack?.split('\n').forEach(l => this.outputChannel.appendLine(l));
				return {} as T;
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
		try {
			return await this.workingOn(this.parser, async() => await this.extractSlice(document, criteria, direction, info), 'slice');
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

	async retrieveDataflowMermaid(document: vscode.TextDocument, simplified = false): Promise<string> {
		if(!this.parser) {
			return '';
		}
		return await this.workingOn(this.parser, async s => {
			const result = await createDataflowPipeline(s, {
				request: requestFromInput(consolidateNewlines(document.getText()))
			}, VSCodeFlowrConfiguration).allRemainingSteps();
			return graphToMermaid({ graph: result.dataflow.graph, simplified, includeEnvironments: false }).string;
		}, 'dfg');

	}

	async retrieveAstMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.parser) {
			return '';
		}
		return await this.workingOn(this.parser, async s => {
			const result = await createNormalizePipeline(s, {
				request: requestFromInput(consolidateNewlines(document.getText()))
			}, VSCodeFlowrConfiguration).allRemainingSteps();
			return normalizedAstToMermaid(result.normalize.ast);
		}, 'ast');
	}

	async retrieveCfgMermaid(document: vscode.TextDocument): Promise<string> {
		if(!this.parser) {
			return '';
		}
		return await this.workingOn(this.parser, async s => {
			const result = await createNormalizePipeline(s, {
				request: requestFromInput(consolidateNewlines(document.getText()))
			}, VSCodeFlowrConfiguration).allRemainingSteps();
			return cfgToMermaid(extractCfgQuick(result.normalize), result.normalize);
		}, 'cfg');
	}

	private async extractSlice(document: vscode.TextDocument, criteria: SlicingCriteria, direction: SliceDirection, info?: { dfi: DataflowInformation, ast: NormalizedAst }): Promise<SliceReturn> {
		const content = consolidateNewlines(document.getText());

		let elements: ReadonlySet<NodeId>;
		let sliceElements: { id: NodeId, location: SourceRange }[];
		let code: string;

		if(info)  {
			const threshold = getConfig().get<number>(Settings.SliceRevisitThreshold, 12);
			this.outputChannel.appendLine(`[Slice (Internal)] Re-Slice using existing dataflow Graph and AST (threshold: ${threshold})`);
			const now = Date.now();
			elements = staticSlice(info.dfi, info.ast, criteria, direction, threshold).result;
			const sliceTime = Date.now() - now;
			sliceElements = makeSliceElements(elements, id => info.ast.idMap.get(id)?.location);
			const reconstructNow = Date.now();
			code = reconstructToCode(info.ast, elements, makeMagicCommentHandler(doNotAutoSelect)).code;
			this.outputChannel.appendLine('[Slice (Internal)] Re-Slice took ' + (Date.now() - now) + 'ms (slice: ' + sliceTime + 'ms, reconstruct: ' + (Date.now() - reconstructNow) + 'ms)');
		} else {
			const threshold = getConfig().get<number>(Settings.SliceRevisitThreshold, 12);
			this.outputChannel.appendLine(`[Slice (Internal)] Slicing using pipeline (threshold: ${threshold})`);
			const now = Date.now();
			const slicer = createSlicePipeline(this.parser as KnownParser, {
				criterion: criteria,
				direction: direction,
				request:   requestFromInput(content),
				threshold
			}, VSCodeFlowrConfiguration);
			const result = await slicer.allRemainingSteps();

			sliceElements = makeSliceElements(result.slice.result, id => result.normalize.idMap.get(id)?.location);
			elements = result.slice.result;
			code = result.reconstruct.code;
			this.outputChannel.appendLine('[Slice (Internal)] Slicing took ' + (Date.now() - now) + 'ms');
		}
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
		const result = await createDataflowPipeline(this.parser, {
			request: requestFromInput(consolidateNewlines(document.getText()))
		}, VSCodeFlowrConfiguration).allRemainingSteps();
		if(result.normalize.hasError && (result.normalize.ast.children as unknown[])?.length === 0) {
			return { result: {} as QueryResults<T>, hasError: true, dfi: result.dataflow, ast: result.normalize };
		}
		return {
			result:   executeQueries({ ast: result.normalize, dataflow: result.dataflow, config: VSCodeFlowrConfiguration }, query),
			hasError: result.normalize.hasError ?? false,
			dfi:      result.dataflow,
			ast:      result.normalize
		};
	}

	public async runRepl(config: Omit<Required<FlowrReplOptions>, 'parser'>) {
		if(!this.parser) {
			return;
		}
		(config.output as { stdout: (s: string) => void}).stdout(await versionReplString(this.parser));
		await repl(VSCodeFlowrConfiguration, { ...config, parser: this.parser });
	}

	public static getEngineToUse(): KnownParserName {
		return isWeb() ? 'tree-sitter' : getConfig().get<KnownParserName>(Settings.Rengine, 'tree-sitter');
	}
}
