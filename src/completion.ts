import * as vscode from 'vscode';
import { allKnownPackageNames, findSigDbPackageSource, resolveSigDbPackageVersion, safeFunctionsOf, safeLatestVersionStr, safeSigDbCall } from './package-db';
import { getInstalledVersion } from './installed-packages';
import { getConfig, Settings } from './settings';
import type { PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';
import { LibraryFunctions } from '@eagleoutice/flowr/queries/catalog/dependencies-query/function-info/library-functions';
import type { FunctionInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/function-info/function-info';
import { findByPrefixIfUnique } from '@eagleoutice/flowr/util/prefix';

function completionEnabled(): boolean {
	return getConfig().get<boolean>(Settings.CompletionEnabled, true);
}

/** matches `library(pkg)` / `require(pkg)`, quoted or bare */
const LibraryCallPattern = /\b(?:library|require)\s*\(\s*['"]?([A-Za-z][A-Za-z0-9._]*)/g;

/** every package named in a `library(pkg)`/`require(pkg)` call (quoted or bare) found in `text` */
export function loadedPackagesIn(text: string): Set<string> {
	const packages = new Set<string>();
	for(const match of text.matchAll(LibraryCallPattern)) {
		packages.add(match[1]);
	}
	return packages;
}

/** the document's text up to (not including) `position` - so completion only ever sees `library()` calls the cursor has actually reached, not ones later in the file */
function textBeforePosition(document: vscode.TextDocument, position: vscode.Position): string {
	return document.getText(new vscode.Range(new vscode.Position(0, 0), position));
}

/** sort rank: plain names first, S3-method-shaped names next, operator/subscript names last */
function completionRank(name: string): '0' | '1' | '2' {
	if(!/^[A-Za-z.]/.test(name)) {
		return '2';
	}
	if(name.includes('.')) {
		return '1';
	}
	return '0';
}

/** finds a function within any of the given (already `library()`-loaded) packages */
async function findFunctionInLoadedPackages(fnName: string, packages: Iterable<string>): Promise<{ pkg: string, source: PackageSignatureSource, version?: string } | undefined> {
	for(const pkg of packages) {
		const found = await findSigDbPackageSource(pkg);
		if(!found) {
			continue;
		}
		const version = safeLatestVersionStr(found.source, pkg);
		if(safeSigDbCall(() => found.source.functionByName(pkg, fnName, version))) {
			return { pkg, source: found.source, version };
		}
	}
	return undefined;
}

class FlowrSigDbCompletionProvider implements vscode.CompletionItemProvider {
	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[]> {
		if(!completionEnabled()) {
			return [];
		}
		const textBefore = textBeforePosition(document, position);
		const packageArgItems = await packageArgumentCompletions(textBefore);
		if(packageArgItems) {
			return token.isCancellationRequested ? [] : packageArgItems;
		}

		const packages = loadedPackagesIn(textBefore);
		if(packages.size === 0) {
			return [];
		}

		const [functionItems, argumentItems] = await Promise.all([
			this.functionNameCompletions(packages),
			this.argumentNameCompletions(document, position, packages)
		]);
		return token.isCancellationRequested ? [] : [...argumentItems, ...functionItems];
	}

	private async functionNameCompletions(packages: Set<string>): Promise<vscode.CompletionItem[]> {
		const perPackage = await Promise.all([...packages].map(async pkg => {
			const found = await findSigDbPackageSource(pkg);
			if(!found) {
				return [];
			}
			const version = safeLatestVersionStr(found.source, pkg);
			const functions = safeFunctionsOf(found.source, pkg, version);
			return functions.filter(fn => fn.exported).map(fn => {
				const params = fn.signature.map(p => p.name).join(', ');
				const item = new vscode.CompletionItem(
					{ label: fn.name, detail: `(${params})`, description: pkg },
					vscode.CompletionItemKind.Function
				);
				item.documentation = new vscode.MarkdownString(`\`\`\`r\n${fn.name}(${params})\n\`\`\`\n\nfrom \`${pkg}\`${version ? ` v${version}` : ''}\n\n*via flowR's signature database*`);
				item.insertText = new vscode.SnippetString(`${fn.name}($0)`);
				item.sortText = `${completionRank(fn.name)}${fn.name}`;
				return item;
			});
		}));
		return perPackage.flat();
	}

	/** right after ( or , (not after name =), suggest the function's own remaining parameter names first */
	private async argumentNameCompletions(document: vscode.TextDocument, position: vscode.Position, packages: Set<string>): Promise<vscode.CompletionItem[]> {
		const call = callBeforeCursor(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
		if(!call || call.inValuePosition) {
			return [];
		}
		const found = await findFunctionInLoadedPackages(call.fnName, packages);
		if(!found) {
			return [];
		}
		const fn = safeSigDbCall(() => found.source.functionByName(found.pkg, call.fnName, found.version));
		if(!fn) {
			return [];
		}
		// resolved against the real parameter list so a partially-typed name (`dat = ` for `data`) still excludes it
		const { filled } = resolveCallArgs(call.rawSegments, fn.signature.map(p => p.name));
		return fn.signature.filter(p => p.name !== '...' && !filled.has(p.name)).map(p => {
			const item = new vscode.CompletionItem(
				{ label: p.name, detail: p.default !== undefined ? ` = ${p.default}` : '', description: `${call.fnName} argument` },
				vscode.CompletionItemKind.Variable
			);
			item.insertText = new vscode.SnippetString(`${p.name} = $0`);
			item.documentation = new vscode.MarkdownString(`parameter of \`${call.fnName}\` from \`${found.pkg}\`\n\n*via flowR's signature database*`);
			item.sortText = `00${p.name}`; // ahead of function-name completions
			return item;
		});
	}

	/** fills in a package's version lazily, since resolving all of CRAN's versions per keystroke would be far too slow */
	async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
		if(item.kind !== vscode.CompletionItemKind.Module || typeof item.label === 'string') {
			return item;
		}
		const pkg = item.label.label.startsWith('package:') ? item.label.label.slice('package:'.length) : item.label.label;
		const [dbVersion, installed] = await Promise.all([resolveSigDbPackageVersion(pkg), getInstalledVersion(pkg)]);
		if(token.isCancellationRequested) {
			return item;
		}
		const parts = [dbVersion && `v${dbVersion}`, installed && installed !== dbVersion ? `installed v${installed}` : undefined].filter((s): s is string => !!s);
		if(parts.length > 0) {
			item.label = { ...item.label, detail: ` — ${parts.join(', ')}` };
		}
		return item;
	}
}

const NamedArgPattern = /^\s*([A-Za-z.][A-Za-z0-9._]*)\s*=(?!=)/;

/** parses argsText (between a call's `(` and the cursor) into its argument index, raw segments, and value-position state */
function parseCallArgs(argsText: string): { argIndex: number, rawSegments: string[], inValuePosition: boolean } {
	const segments: string[] = [];
	let depth = 0;
	let segStart = 0;
	for(let i = 0; i < argsText.length; i++) {
		const c = argsText[i];
		if(c === '(' || c === '[' || c === '{') {
			depth++;
		} else if(c === ')' || c === ']' || c === '}') {
			depth--;
		} else if(c === ',' && depth === 0) {
			segments.push(argsText.slice(segStart, i));
			segStart = i + 1;
		}
	}
	segments.push(argsText.slice(segStart));

	const inValuePosition = NamedArgPattern.test(segments[segments.length - 1]);
	return { argIndex: segments.length - 1, rawSegments: segments, inValuePosition };
}

/** matches the innermost open call `fnName(args, so, far` immediately before the cursor, to drive signature help */
export function callBeforeCursor(text: string): { fnName: string, argIndex: number, rawSegments: string[], inValuePosition: boolean } | undefined {
	let depth = 0;
	for(let i = text.length - 1; i >= 0; i--) {
		const c = text[i];
		if(c === ')' || c === ']' || c === '}') {
			depth++;
		} else if(c === '(') {
			if(depth === 0) {
				const before = text.slice(0, i);
				const m = /([A-Za-z.][A-Za-z0-9._]*)\s*$/.exec(before);
				return m ? { fnName: m[1], ...parseCallArgs(text.slice(i + 1)) } : undefined;
			}
			depth--;
		} else if(c === '[' || c === '{') {
			depth--;
		}
	}
	return undefined;
}

/** resolves a typed name against real parameter names via R's own pmatch rule: exact match wins, else an unambiguous prefix before `...`; undefined if unknown or ambiguous */
export function resolveArgNameAgainst(typed: string, paramNames: readonly string[]): string | undefined {
	return findByPrefixIfUnique(typed, paramNames);
}

/** resolves every argument of a call via R's three-pass matching: named args claim their formal first, then unnamed args fill remaining formals in order, stopping at `...` */
export function resolveCallArgs(rawSegments: readonly string[], paramNames: readonly string[]): { filled: Set<string>, current?: string } {
	const namedAt = rawSegments.map(seg => NamedArgPattern.exec(seg)?.[1]);
	const resolvedNamedAt = namedAt.map(name => name !== undefined ? resolveArgNameAgainst(name, paramNames) : undefined);
	const filled = new Set(resolvedNamedAt.filter((name): name is string => name !== undefined));

	let positionalIdx = 0;
	// the next formal reachable positionally; `...` is returned and never advanced past once reached
	const nextPositionalFormal = (): string | undefined => {
		while(positionalIdx < paramNames.length) {
			const name = paramNames[positionalIdx];
			if(name === '...') {
				return '...';
			}
			positionalIdx++;
			if(!filled.has(name)) {
				return name;
			}
		}
		return undefined;
	};

	let current: string | undefined;
	for(let i = 0; i < rawSegments.length; i++) {
		const isLast = i === rawSegments.length - 1;
		if(namedAt[i] !== undefined) {
			if(isLast) {
				current = resolvedNamedAt[i];
			}
			continue;
		}
		const formal = nextPositionalFormal();
		if(isLast) {
			current = formal;
		} else if(formal !== undefined && formal !== '...') {
			filled.add(formal);
		}
	}
	return { filled, current };
}

/** `detach` mirrors `attach`'s "package:<pkg>" argument but loads nothing, so flowR's {@link LibraryFunctions} omits it */
const ExtraPackageArgFunctions: FunctionInfo[] = [
	{ package: 'base', name: 'detach', argIdx: 0, argName: 'name', resolveValue: true }
];

/** every call flowR (plus {@link ExtraPackageArgFunctions}) recognizes as taking a package name argument, by function name */
const PackageArgFunctions: Map<string, FunctionInfo> = new Map(
	[...LibraryFunctions, ...ExtraPackageArgFunctions].map(info => [info.name, info])
);

/** functions whose package argument is also commonly given in `package:<pkg>` form - the name R itself puts on the search path */
const PackageColonForms = new Set(['attach', 'detach']);

/** a function's real, ordered parameter names from flowR's signature database, or `undefined` if unresolvable (package not synced/found, or the function isn't in it) */
async function sigDbParamNames(pkg: string, fnName: string): Promise<string[] | undefined> {
	const found = await findSigDbPackageSource(pkg);
	if(!found) {
		return undefined;
	}
	const fn = safeSigDbCall(() => found.source.functionByName(pkg, fnName));
	return fn?.signature.map(p => p.name);
}

/** whether the cursor sits at `info`'s package-name argument; prefers the real sigdb signature, falls back to `info.argName` alone */
async function isAtPackageArgPosition(call: { rawSegments: string[], inValuePosition: boolean }, info: FunctionInfo): Promise<boolean> {
	if(info.argIdx === 'unnamed') {
		return !call.inValuePosition;
	}
	if(info.argName === undefined) {
		return false;
	}
	const paramNames = (info.package && await sigDbParamNames(info.package, info.name)) || [info.argName];
	return resolveCallArgs(call.rawSegments, paramNames).current === info.argName;
}

function packageNameCompletionItem(label: string, insertText: string): vscode.CompletionItem {
	const item = new vscode.CompletionItem({ label, description: 'package' }, vscode.CompletionItemKind.Module);
	item.insertText = insertText;
	item.sortText = label;
	return item;
}

/** completions for a `library(...)`/`attach(...)`/... package-name argument, or `undefined` if the cursor isn't in one */
export async function packageArgumentCompletions(textBeforeCursor: string): Promise<vscode.CompletionItem[] | undefined> {
	const call = callBeforeCursor(textBeforeCursor);
	const info = call && PackageArgFunctions.get(call.fnName);
	if(!call || !info || !await isAtPackageArgPosition(call, info)) {
		return undefined;
	}
	const names = [...await allKnownPackageNames()].sort((a, b) => a.localeCompare(b));
	const items = names.map(pkg => packageNameCompletionItem(pkg, pkg));
	if(PackageColonForms.has(call.fnName)) {
		items.push(...names.map(pkg => packageNameCompletionItem(`package:${pkg}`, `package:${pkg}`)));
	}
	return items;
}

class FlowrSigDbSignatureHelpProvider implements vscode.SignatureHelpProvider {
	async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
		if(!completionEnabled()) {
			return undefined;
		}
		const call = callBeforeCursor(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
		if(!call) {
			return undefined;
		}
		const found = await findFunctionInLoadedPackages(call.fnName, loadedPackagesIn(textBeforePosition(document, position)));
		if(!found || token.isCancellationRequested) {
			return undefined;
		}
		const fn = safeSigDbCall(() => found.source.functionByName(found.pkg, call.fnName, found.version));
		if(!fn) {
			return undefined;
		}

		const paramLabels = fn.signature.map(p => p.default !== undefined ? `${p.name} = ${p.default}` : p.name);
		const info = new vscode.SignatureInformation(`${fn.name}(${paramLabels.join(', ')})`);
		info.parameters = paramLabels.map(label => new vscode.ParameterInformation(label));
		info.documentation = new vscode.MarkdownString(`from \`${found.pkg}\`${found.version ? ` v${found.version}` : ''}\n\n*via flowR's signature database*`);

		// resolved against the real parameter list so a named or out-of-order argument highlights its actual target
		const paramNames = fn.signature.map(p => p.name);
		const resolved = resolveCallArgs(call.rawSegments, paramNames).current;
		const resolvedIdx = resolved !== undefined ? paramNames.indexOf(resolved) : -1;

		const help = new vscode.SignatureHelp();
		help.signatures = [info];
		help.activeSignature = 0;
		help.activeParameter = resolvedIdx >= 0 ? resolvedIdx : Math.min(call.argIndex, Math.max(paramLabels.length - 1, 0));
		return help;
	}
}

/** whether REditorSupport.r is active - it already provides richer, R-evaluated completions, so we stay out of its way */
function rLanguageServerActive(): boolean {
	const ext = vscode.extensions.getExtension('reditorsupport.r');
	return !!ext?.isActive;
}

/** registers R/Rmd completion + signature help for `library()`d packages, backed by whichever sigdb scopes are downloaded; skipped if REditorSupport.r is active */
export function registerCompletion(): vscode.Disposable {
	if(rLanguageServerActive()) {
		return new vscode.Disposable(() => { /* nothing registered */ });
	}
	const selectors: vscode.DocumentSelector[] = [{ language: 'r' }, { language: 'rmd' }];
	return vscode.Disposable.from(
		...selectors.map(selector => vscode.languages.registerCompletionItemProvider(selector, new FlowrSigDbCompletionProvider(), '(', ',', ' ', '"', '\'')),
		...selectors.map(selector => vscode.languages.registerSignatureHelpProvider(selector, new FlowrSigDbSignatureHelpProvider(), '(', ','))
	);
}
