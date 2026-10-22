import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import { isRTypeLanguage } from './configurable-refresher';
import { isLocInDocument } from './lint';
import { rangeToVscodeRange } from './flowr/utils';
import type { DataflowInformation } from '@eagleoutice/flowr/dataflow/info';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { DfgVertex } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { DfEdge, EdgeType } from '@eagleoutice/flowr/dataflow/graph/edge';
import { RFunctionCall } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-function-call';
import { RFunctionDefinition } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-function-definition';
import { RBinaryOp } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-binary-op';
import { RArgument } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-argument';
import { RString } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-string';
import { RSymbol } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-symbol';
import { SourceLocation, SourceRange } from '@eagleoutice/flowr/util/range';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';

export type SearchKind = 'variable' | 'function' | 'call' | 'string';
export type OccurrenceRole = 'definition' | 'use' | 'call' | 'passed to' | 'flows into' | 'string';

export interface Occurrence {
	role:   OccurrenceRole
	range:  vscode.Range
	/** the other end of a flow (`flows into y`, `passed to filter()`), or the call a string is given to */
	other?: string
}

export interface SearchEntry {
	name:        string
	kind:        SearchKind
	occurrences: Occurrence[]
}

const Icons: Record<SearchKind, string> = { variable: 'symbol-variable', function: 'symbol-function', call: 'symbol-method', string: 'symbol-string' };
const RoleIcons: Record<OccurrenceRole, string> = { 'definition': 'symbol-field', 'use': 'eye', 'call': 'debug-start', 'passed to': 'arrow-right', 'flows into': 'arrow-down', 'string': 'quote' };

const DataEdges = EdgeType.Reads | EdgeType.Argument | EdgeType.DefinedBy | EdgeType.Returns;

const symbolName = (node: RNode | undefined) => RSymbol.is(node) ? Identifier.getName(node.content) : node?.lexeme;
const callName = (node: RNode | undefined) => RFunctionCall.isNamed(node) ? Identifier.getName(node.functionName.content) : undefined;

function isFunctionAssignment(ast: NormalizedAst, id: NodeId): boolean {
	const node = ast.idMap.get(id);
	const parent = node?.info.parent === undefined ? undefined : ast.idMap.get(node.info.parent);
	if(!RBinaryOp.is(parent)) {
		return false;
	}
	const value = parent.lhs === node ? parent.rhs : parent.lhs;
	return RFunctionDefinition.is(value);
}

/**
 * Where the value of the definition `def` goes, following the dataflow graph: the calls it is passed to and the variables
 * it directly flows into (without following those variables further).
 */
function flowsOf(dfi: DataflowInformation, ast: NormalizedAst, def: NodeId): { role: 'passed to' | 'flows into', id: NodeId, name: string }[] {
	const graph = dfi.graph;
	const result: { role: 'passed to' | 'flows into', id: NodeId, name: string }[] = [];
	const seen = new Set<NodeId>([def]);
	let frontier: NodeId[] = [def];
	for(let depth = 0; depth < 6 && frontier.length > 0; depth++) {
		const next: NodeId[] = [];
		for(const id of frontier) {
			for(const [source, edge] of graph.edgesTo(id)) {
				if(seen.has(source) || !DfEdge.includesType(edge, DataEdges)) {
					continue;
				}
				seen.add(source);
				const vertex = graph.getVertex(source);
				const node = ast.idMap.get(source);
				if(DfgVertex.isVariableDefinition(vertex)) {
					result.push({ role: 'flows into', id: source, name: symbolName(node) ?? String(source) });
					continue;
				}
				const call = callName(node);
				if(DfgVertex.isFunctionCall(vertex) && call) {
					result.push({ role: 'passed to', id: source, name: `${call}()` });
				}
				next.push(source);
			}
		}
		frontier = next;
	}
	return result;
}

/** indexes the variables, functions, calls and strings of `document`, using flowR's dataflow graph and normalized AST */
export function buildSearchIndex(dfi: DataflowInformation, ast: NormalizedAst, document: vscode.TextDocument): SearchEntry[] {
	const entries = new Map<string, SearchEntry>();
	const inDocument = (node: RNode | undefined): node is RNode => {
		const loc = SourceLocation.fromNode(node);
		return loc !== undefined && isLocInDocument(loc, document);
	};
	const rangeOf = (node: RNode) => rangeToVscodeRange(SourceRange.fromNode(node) ?? [1, 1, 1, 1]);
	const entry = (key: string, name: string, kind: SearchKind) => {
		let e = entries.get(key);
		if(!e) {
			e = { name, kind, occurrences: [] };
			entries.set(key, e);
		}
		return e;
	};

	for(const [id, vertex] of dfi.graph.vertices(true)) {
		const node = ast.idMap.get(id);
		if(!inDocument(node)) {
			continue;
		}
		if(DfgVertex.isVariableDefinition(vertex) || DfgVertex.isUse(vertex)) {
			const name = symbolName(node);
			if(!name) {
				continue;
			}
			const e = entry(`sym:${name}`, name, 'variable');
			if(DfgVertex.isUse(vertex)) {
				e.occurrences.push({ role: 'use', range: rangeOf(node) });
				continue;
			}
			e.occurrences.push({ role: 'definition', range: rangeOf(node) });
			if(isFunctionAssignment(ast, id)) {
				e.kind = 'function';
				continue;
			}
			for(const flow of flowsOf(dfi, ast, id)) {
				const target = ast.idMap.get(flow.id);
				if(inDocument(target)) {
					e.occurrences.push({ role: flow.role, range: rangeOf(target), other: flow.name });
				}
			}
		} else if(DfgVertex.isFunctionCall(vertex)) {
			const name = callName(node);
			if(name && RFunctionCall.isNamed(node)) {
				const e = entry(`sym:${name}`, name, 'call');
				e.occurrences.push({ role: 'call', range: rangeOf(node.functionName) });
			}
		}
	}

	for(const node of ast.idMap.values()) {
		if(RString.is(node) && inDocument(node)) {
			const parent = node.info.parent === undefined ? undefined : ast.idMap.get(node.info.parent);
			const call = callName(RArgument.is(parent) && parent.info.parent !== undefined ? ast.idMap.get(parent.info.parent) : parent);
			entry(`str:${node.content.str}`, node.content.str, 'string').occurrences.push({ role: 'string', range: rangeOf(node), other: call && `${call}()` });
		}
	}

	const first = (e: SearchEntry) => e.occurrences.reduce((a, o) => o.range.start.isBefore(a) ? o.range.start : a, e.occurrences[0].range.start);
	return [...entries.values()].filter(e => e.occurrences.length > 0).map(e => {
		const unique = new Map(e.occurrences.map(o => [`${o.role}@${o.range.start.line}:${o.range.start.character}@${o.other}`, o]));
		const occurrences = [...unique.values()].sort((a, b) => a.range.start.compareTo(b.range.start));
		const kind = e.kind === 'variable' && !occurrences.some(o => o.role === 'definition' || o.role === 'use') ? 'call' : e.kind;
		return { ...e, kind, occurrences };
	}).sort((a, b) => first(a).compareTo(first(b)));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** a one-line summary of an entry: how often it is defined, used and called, and where its value flows */
export function summarize(e: SearchEntry): string {
	const count = (role: OccurrenceRole) => e.occurrences.filter(o => o.role === role).length;
	const others = (role: OccurrenceRole) => [...new Set(e.occurrences.filter(o => o.role === role).map(o => o.other))];
	const parts = [
		count('definition') && plural(count('definition'), 'definition'),
		count('use') && plural(count('use'), 'use'),
		count('call') && plural(count('call'), 'call'),
		count('string') && plural(count('string'), 'occurrence'),
		count('passed to') && `passed to ${others('passed to').join(', ')}`,
		count('flows into') && `flows into ${others('flows into').join(', ')}`
	];
	if(e.kind === 'string' && others('string').some(Boolean)) {
		parts.push(`given to ${others('string').filter(Boolean).join(', ')}`);
	}
	return parts.filter(Boolean).join(' · ');
}

function describeOccurrence(o: Occurrence): string {
	switch(o.role) {
		case 'passed to': return `passed to ${o.other}`;
		case 'flows into': return `flows into ${o.other}`;
		case 'string': return o.other ? `given to ${o.other}` : 'string';
		default: return o.role;
	}
}

export const SearchKinds: readonly SearchKind[] = ['variable', 'function', 'call', 'string'];
const KindNames: Record<SearchKind, string> = { variable: 'variables', function: 'functions', call: 'called functions', string: 'strings' };

/** the parts of a name, split at `.`, `_`, `-`, `/`, spaces and camelCase humps (`my_data.frame` has `my`, `data` and `frame`) */
export function nameParts(name: string): string[] {
	return name.split(/[._\-/\\\s:]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map(p => p.toLowerCase());
}

/**
 * How well `query` matches `name`, case-insensitively, or `undefined` for no match: the whole name, its start, the start of
 * one of its parts (`csv` for `measurements.csv`), the initials of its parts (`md` for `my_data`), anywhere in it, or as a
 * subsequence of its letters.
 */
export function matchScore(name: string, query: string): number | undefined {
	const n = name.toLowerCase();
	const q = query.toLowerCase().trim();
	if(!q) {
		return 0;
	}
	const parts = nameParts(name);
	if(n === q) {
		return 100;
	} else if(n.startsWith(q)) {
		return 80;
	} else if(parts.some(p => p.startsWith(q))) {
		return 60;
	} else if(parts.length > 1 && parts.map(p => p[0]).join('').startsWith(q)) {
		return 50;
	} else if(n.includes(q)) {
		return 40;
	}
	let at = 0;
	for(const c of q) {
		at = n.indexOf(c, at) + 1;
		if(at === 0) {
			return undefined;
		}
	}
	return 10;
}

const KindFilters: Record<string, SearchKind> = { v: 'variable', var: 'variable', variable: 'variable', f: 'function', fn: 'function', function: 'function', c: 'call', call: 'call', s: 'string', str: 'string', string: 'string' };

/** splits a search into its text and the kinds named by `@variable`, `@function`, `@call`, `@string` (or `@v`, `@f`, `@c`, `@s`) */
export function parseQuery(value: string): { text: string, kinds?: Set<SearchKind> } {
	const kinds = new Set<SearchKind>();
	const text = parseRoles(value, false).text.replace(/(^|\s)@(\w+)\b/g, (all, _space, name: string) => {
		const kind = KindFilters[name.toLowerCase()];
		if(kind) {
			kinds.add(kind);
			return '';
		}
		return all;
	}).trim();
	return { text, kinds: kinds.size > 0 ? kinds : undefined };
}

/** the entries of the kinds `enabled` (or those the query names) that match the query, best match first, then in file order */
export function filterEntries(entries: readonly SearchEntry[], value: string, enabled: ReadonlySet<SearchKind>): SearchEntry[] {
	const { text, kinds } = parseQuery(value);
	const allowed = kinds ?? enabled;
	return entries
		.filter(e => allowed.has(e.kind))
		.map((e, i) => ({ e, i, score: matchScore(e.name, text) }))
		.filter((m): m is { e: SearchEntry, i: number, score: number } => m.score !== undefined)
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.map(m => m.e);
}

interface EntryItem extends vscode.QuickPickItem { entry?: SearchEntry, text?: string, insert?: string }
interface OccurrenceItem extends vscode.QuickPickItem { range?: vscode.Range, insert?: string }
interface KindButton extends vscode.QuickInputButton { kind: SearchKind }

/** all ranges of `text` in the document, for a free-text search that the index does not cover */
function textOccurrences(document: vscode.TextDocument, text: string): Occurrence[] {
	const content = document.getText();
	const result: Occurrence[] = [];
	for(let at = content.indexOf(text); at >= 0 && result.length < 500; at = content.indexOf(text, at + Math.max(text.length, 1))) {
		result.push({ role: 'use', range: new vscode.Range(document.positionAt(at), document.positionAt(at + text.length)) });
	}
	return result;
}

function previewIn(editor: vscode.TextEditor) {
	return (range: vscode.Range) => {
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	};
}

const RoleGroups: [string, OccurrenceRole[]][] = [['definitions', ['definition']], ['uses and calls', ['use', 'call', 'string']], ['where its value goes', ['passed to', 'flows into']]];

const RoleFilters: Record<string, { roles: OccurrenceRole[], what: string }> = {
	def:  { roles: ['definition'], what: 'definitions' },
	use:  { roles: ['use', 'string'], what: 'uses' },
	call: { roles: ['call'], what: 'calls' },
	flow: { roles: ['passed to', 'flows into'], what: 'where the value goes' }
};
const RoleAliases: Record<string, string> = { def: 'def', definition: 'def', definitions: 'def', d: 'def', use: 'use', uses: 'use', u: 'use', call: 'call', calls: 'call', flow: 'flow', flows: 'flow' };

/**
 * Splits the filter of an occurrence list into its text and the roles named by `@def`, `@use`, `@call` and `@flow`.
 * Without `withCall`, `@call` is left alone, as the first step of the search uses it for called functions.
 */
export function parseRoles(value: string, withCall = true): { text: string, roles?: Set<OccurrenceRole> } {
	const roles = new Set<OccurrenceRole>();
	const text = value.replace(/(^|\s)@(\w+)\b/g, (all, _space, name: string) => {
		const filter = RoleAliases[name.toLowerCase()];
		if(filter && (withCall || filter !== 'call')) {
			RoleFilters[filter].roles.forEach(r => roles.add(r));
			return '';
		}
		return all;
	}).trim();
	return { text, roles: roles.size > 0 ? roles : undefined };
}

/** the occurrences with the roles and the text (in the code of their line or their description) the filter asks for */
export function filterOccurrences<T extends { role: OccurrenceRole }>(occurrences: readonly T[], value: string, textOf: (o: T) => string): T[] {
	const { text, roles } = parseRoles(value);
	return occurrences.filter(o => (!roles || roles.has(o.role)) && (!text || textOf(o).toLowerCase().includes(text.toLowerCase())));
}

const filterSuggestions = <T extends vscode.QuickPickItem>(value: string, names: [string, string][], make: (item: vscode.QuickPickItem, insert: string) => T): T[] =>
	/(^|\s)@\w*$/.test(value) ? names.map(([name, what]) => make({ label: `@${name}`, description: `only ${what}`, alwaysShow: true }, `${value.replace(/@\w*$/, '')}@${name} `)) : [];

async function pickOccurrence(editor: vscode.TextEditor, title: string, occurrences: Occurrence[], describe: (o: Occurrence) => string, initial = ''): Promise<'back' | 'done'> {
	const original = editor.selection;
	const pick = vscode.window.createQuickPick<OccurrenceItem>();
	pick.title = title;
	pick.placeholder = 'Filter the code, or @def, @use, @call, @flow';
	pick.buttons = [vscode.QuickInputButtons.Back];
	const code = (o: Occurrence) => editor.document.lineAt(o.range.start.line).text.trim();
	const textOf = (o: Occurrence) => `${code(o)} ${describe(o)}`;
	const render = () => {
		const shown = filterOccurrences(occurrences, pick.value, textOf);
		const suggestions = filterSuggestions(pick.value, Object.entries(RoleFilters).map(([name, f]): [string, string] => [name, f.what]), (item, insert): OccurrenceItem => ({ ...item, insert }));
		pick.items = [...suggestions, ...RoleGroups.flatMap(([label, roles]) => {
			const group = shown.filter(o => roles.includes(o.role));
			return group.length > 0 ? [
				{ label: `${label} (${group.length})`, kind: vscode.QuickPickItemKind.Separator },
				...group.map((o): OccurrenceItem => {
					const line = code(o);
					return {
						label:       `$(${RoleIcons[o.role]}) ${o.range.start.line + 1}: ${line.length > 70 ? `${line.slice(0, 69)}…` : line}`,
						description: describe(o),
						alwaysShow:  true,
						range:       o.range
					};
				})
			] : [];
		})];
	};
	pick.value = initial;
	render();
	pick.onDidChangeValue(render);
	const reveal = previewIn(editor);
	return new Promise(resolve => {
		let accepted = false;
		pick.onDidChangeActive(([active]) => active?.range && reveal(active.range));
		pick.onDidTriggerButton(() => {
			accepted = true;
			editor.selection = original;
			pick.hide();
			resolve('back');
		});
		pick.onDidAccept(() => {
			const [selected] = pick.activeItems;
			if(selected?.insert) {
				pick.value = selected.insert;
				render();
			} else if(selected?.range) {
				accepted = true;
				reveal(selected.range);
				pick.hide();
				void vscode.window.showTextDocument(editor.document, editor.viewColumn);
				resolve('done');
			}
		});
		pick.onDidHide(() => {
			if(!accepted) {
				editor.selection = original;
				editor.revealRange(original);
				resolve('done');
			}
			pick.dispose();
		});
		pick.show();
	});
}

/** the `@def`/`@use`/`@flow` filters of a search, which are carried over to its occurrence list */
const roleFilterOf = (value: string) => (value.match(/(^|\s)@\w+\b/g) ?? []).map(f => f.trim()).filter(f => RoleAliases[f.slice(1).toLowerCase()] && RoleAliases[f.slice(1).toLowerCase()] !== 'call').map(f => `${f} `).join('');

const EnabledKindsKey = 'vscode-flowr.search.kinds';

/** registers `vscode-flowr.search`, a search over the variables, functions and strings of the current file */
export function registerSearch(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	const index = async(document: vscode.TextDocument): Promise<SearchEntry[] | undefined> => {
		try {
			const { dfi, ast } = await (await getFlowrSession()).retrieveQuery(document, [{ type: 'normalized-ast' }]);
			return dfi && ast ? buildSearchIndex(dfi, ast, document) : undefined;
		} catch(e) {
			output.appendLine(`[Search] failed: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	};

	registerCommand(context, 'vscode-flowr.search', async(initial?: string) => {
		const editor = vscode.window.activeTextEditor;
		if(!editor || !isRTypeLanguage(editor.document)) {
			void vscode.window.showWarningMessage('flowR: Open an R file to search.');
			return;
		}
		const original = editor.selection;
		const enabled = new Set<SearchKind>(context.workspaceState.get<SearchKind[]>(EnabledKindsKey, [...SearchKinds]));
		const pick = vscode.window.createQuickPick<EntryItem>();
		pick.placeholder = 'Name or part of it; filter with @variable, @function, @call, @string';
		pick.matchOnDescription = true;
		pick.busy = true;
		if(typeof initial === 'string') {
			pick.value = initial;
		}
		pick.show();
		const entries = await index(editor.document) ?? [];
		pick.busy = false;

		const toItem = (e: SearchEntry): EntryItem => ({
			label:       `$(${Icons[e.kind]}) ${e.kind === 'string' ? `"${e.name}"` : e.name}`,
			description: `${e.kind} · line ${e.occurrences[0].range.start.line + 1}`,
			detail:      summarize(e),
			// the own matching (parts, initials) decides what is shown, not the built-in fuzzy filter
			alwaysShow:  true,
			entry:       e
		});
		const render = () => {
			const shown = SearchKinds.filter(k => enabled.has(k));
			pick.title = `flowR search: ${shown.length === SearchKinds.length ? 'all' : shown.map(k => KindNames[k]).join(', ') || 'nothing shown'}`;
			pick.buttons = SearchKinds.map((kind): KindButton => ({
				kind,
				iconPath: new vscode.ThemeIcon(enabled.has(kind) ? Icons[kind] : 'circle-slash'),
				tooltip:  `${enabled.has(kind) ? 'Hide' : 'Show'} ${KindNames[kind]}`
			}));
			const value = pick.value;
			const filters = filterSuggestions(value, [
				['variable', 'variables'], ['function', 'functions defined here'], ['call', 'called functions'], ['string', 'strings'],
				['def', 'definitions'], ['use', 'uses'], ['flow', 'where the value goes']
			], (item, insert): EntryItem => ({ ...item, insert }));
			const { text } = parseQuery(value);
			const found = filterEntries(entries, value, enabled).slice(0, 300).map(toItem);
			const literal: EntryItem[] = text ? [{ label: `$(search) Find "${text}" in the code`, description: `${textOccurrences(editor.document, text).length} matches`, alwaysShow: true, text }] : [];
			pick.items = [...filters, ...found, ...literal];
		};
		render();
		pick.onDidChangeValue(render);
		pick.onDidTriggerButton(button => {
			const kind = (button as KindButton).kind;
			if(enabled.has(kind)) {
				enabled.delete(kind);
			} else {
				enabled.add(kind);
			}
			void context.workspaceState.update(EnabledKindsKey, [...enabled]);
			render();
		});
		const reveal = previewIn(editor);
		pick.onDidChangeActive(([item]) => {
			const at = item?.entry?.occurrences.find(o => o.role === 'definition') ?? item?.entry?.occurrences[0];
			if(at) {
				reveal(at.range);
			}
		});
		let choosing = false;
		pick.onDidHide(() => {
			if(!choosing) {
				editor.selection = original;
				editor.revealRange(original);
				pick.dispose();
			}
		});

		const choose = async(item: EntryItem) => {
			const occurrences = item.entry ? item.entry.occurrences : textOccurrences(editor.document, item.text ?? '');
			if(occurrences.length === 1) {
				choosing = true;
				pick.hide();
				reveal(occurrences[0].range);
				pick.dispose();
				return;
			}
			choosing = true;
			pick.hide();
			editor.selection = original;
			const result = item.entry
				? await pickOccurrence(editor, `${item.entry.name} (${item.entry.kind}): ${summarize(item.entry)}`, occurrences, describeOccurrence, roleFilterOf(pick.value))
				: await pickOccurrence(editor, `"${item.text}" in the code`, occurrences, () => 'text match');
			choosing = false;
			if(result === 'back') {
				pick.show();
			} else {
				pick.dispose();
			}
		};
		pick.onDidAccept(() => {
			const [item] = pick.activeItems;
			if(item?.insert) {
				pick.value = item.insert;
				render();
			} else if(item) {
				void choose(item);
			}
		});
	});

	registerCommand(context, 'vscode-flowr.internal.search.index', async() => {
		const document = vscode.window.activeTextEditor?.document;
		if(!isRTypeLanguage(document)) {
			return [];
		}
		return (await index(document) ?? []).map(e => ({
			name:        e.name,
			kind:        e.kind,
			summary:     summarize(e),
			occurrences: e.occurrences.map(o => ({ role: o.role, line: o.range.start.line, other: o.other }))
		}));
	});
}
