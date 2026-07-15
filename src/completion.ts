import * as vscode from 'vscode';
import { findSigDbPackageSource } from './package-db';
import type { PackageSignatureSource } from '@eagleoutice/flowr/project/sigdb/reader';

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

/**
 * sort rank prefix for a function name: plain names first, S3-method-shaped names (`print.data.frame`) next,
 *  operator/subscript names (`[`, `[[`, `$`, `+`, ...) last - so the more broadly useful names surface first
 */
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
		const version = found.source.latestVersion(pkg)?.str;
		if(found.source.functions(pkg, version)?.some(f => f.name === fnName)) {
			return { pkg, source: found.source, version };
		}
	}
	return undefined;
}

class FlowrSigDbCompletionProvider implements vscode.CompletionItemProvider {
	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
		const packages = loadedPackagesIn(textBeforePosition(document, position));
		if(packages.size === 0) {
			return [];
		}

		const [functionItems, argumentItems] = await Promise.all([
			this.functionNameCompletions(packages),
			this.argumentNameCompletions(document, position, packages)
		]);
		return [...argumentItems, ...functionItems];
	}

	private async functionNameCompletions(packages: Set<string>): Promise<vscode.CompletionItem[]> {
		const perPackage = await Promise.all([...packages].map(async pkg => {
			const found = await findSigDbPackageSource(pkg);
			if(!found) {
				return [];
			}
			const version = found.source.latestVersion(pkg)?.str;
			const functions = found.source.functions(pkg, version) ?? [];
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

	/**
	 * when the cursor sits at the start of an (empty or partially-typed) argument name - right after `(` or a
	 * `,`, not after that argument's own `name = ` - suggest the function's own remaining parameter names
	 * (`data = `, `mapping = `, ...) ahead of general function-name completions
	 */
	private async argumentNameCompletions(document: vscode.TextDocument, position: vscode.Position, packages: Set<string>): Promise<vscode.CompletionItem[]> {
		const call = callBeforeCursor(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
		if(!call || call.inValuePosition) {
			return [];
		}
		const found = await findFunctionInLoadedPackages(call.fnName, packages);
		if(!found) {
			return [];
		}
		const fn = found.source.functions(found.pkg, found.version)?.find(f => f.name === call.fnName);
		if(!fn) {
			return [];
		}
		return fn.signature.filter(p => p.name !== '...' && !call.usedArgs.has(p.name)).map(p => {
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
}

const NamedArgPattern = /^\s*([A-Za-z.][A-Za-z0-9._]*)\s*=(?!=)/;

/**
 * the top-level (depth-0) comma-separated argument index, the set of already-named arguments, and whether the
 * cursor is past the current (last) argument's own `name = ` - i.e. typing that argument's *value*, where
 * suggesting further argument names would be wrong - in `argsText` (the text between a call's `(` and the cursor)
 */
function parseCallArgs(argsText: string): { argIndex: number, usedArgs: Set<string>, inValuePosition: boolean } {
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

	const usedArgs = new Set<string>();
	for(const seg of segments) {
		const m = NamedArgPattern.exec(seg);
		if(m) {
			usedArgs.add(m[1]);
		}
	}
	return { argIndex: segments.length - 1, usedArgs, inValuePosition: NamedArgPattern.test(segments[segments.length - 1]) };
}

/** matches the innermost open call `fnName(args, so, far` immediately before the cursor, to drive signature help */
export function callBeforeCursor(text: string): { fnName: string, argIndex: number, usedArgs: Set<string>, inValuePosition: boolean } | undefined {
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

class FlowrSigDbSignatureHelpProvider implements vscode.SignatureHelpProvider {
	async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.SignatureHelp | undefined> {
		const call = callBeforeCursor(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
		if(!call) {
			return undefined;
		}
		const found = await findFunctionInLoadedPackages(call.fnName, loadedPackagesIn(textBeforePosition(document, position)));
		if(!found) {
			return undefined;
		}
		const fn = found.source.functions(found.pkg, found.version)?.find(f => f.name === call.fnName);
		if(!fn) {
			return undefined;
		}

		const paramLabels = fn.signature.map(p => p.default !== undefined ? `${p.name} = ${p.default}` : p.name);
		const info = new vscode.SignatureInformation(`${fn.name}(${paramLabels.join(', ')})`);
		info.parameters = paramLabels.map(label => new vscode.ParameterInformation(label));
		info.documentation = new vscode.MarkdownString(`from \`${found.pkg}\`${found.version ? ` v${found.version}` : ''}\n\n*via flowR's signature database*`);

		const help = new vscode.SignatureHelp();
		help.signatures = [info];
		help.activeSignature = 0;
		help.activeParameter = Math.min(call.argIndex, Math.max(paramLabels.length - 1, 0));
		return help;
	}
}

/**
 * whether the official R language server extension (REditorSupport.r) is installed and active - if so, it
 *  already provides richer, R-evaluated completions/signature help, so we stay out of its way
 */
function rLanguageServerActive(): boolean {
	const ext = vscode.extensions.getExtension('reditorsupport.r');
	return !!ext?.isActive;
}

/**
 * Registers R/Rmd completion + signature help for functions of packages the current document `library()`s,
 *  backed by whichever signature-database scopes are actually downloaded. Skipped entirely when the official
 *  R language server extension is active, to avoid duplicate/conflicting suggestions.
 */
export function registerCompletion(): vscode.Disposable {
	if(rLanguageServerActive()) {
		return new vscode.Disposable(() => { /* nothing registered */ });
	}
	const selectors: vscode.DocumentSelector[] = [{ language: 'r' }, { language: 'rmd' }];
	return vscode.Disposable.from(
		...selectors.map(selector => vscode.languages.registerCompletionItemProvider(selector, new FlowrSigDbCompletionProvider(), '(', ',', ' ')),
		...selectors.map(selector => vscode.languages.registerSignatureHelpProvider(selector, new FlowrSigDbSignatureHelpProvider(), '(', ','))
	);
}
