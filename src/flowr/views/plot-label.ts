import type { DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { NormalizedAst, ParentInformation } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { RFunctionCall } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-function-call';
import { RArgument } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-argument';
import { RString } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-string';
import { RSymbol } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-symbol';
import { RBinaryOp } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-binary-op';
import { RPipe } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-pipe';
import { RExpressionList } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-expression-list';
import { RAccess } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-access';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';

const Devices = new Set(['png', 'pdf', 'jpeg', 'bmp', 'tiff', 'svg', 'cairo_pdf', 'postscript']);
const Combinators = new Set(['+', '%>%', '|>']);

type Ast = NormalizedAst['idMap'];

function callName(node: RNode | undefined): string | undefined {
	return RFunctionCall.isNamed(node) ? Identifier.getName(node.functionName.content) : undefined;
}

/** the argument called `name`, else the `position`-th unnamed one */
function argument(node: RNode | undefined, name: string, position = -1): RArgument | undefined {
	const args = RFunctionCall.is(node) ? node.arguments.filter(RArgument.isNotEmpty) : [];
	return args.find(a => a.name && Identifier.getName(a.name.content) === name) ?? args.filter(a => !a.name)[position];
}

function stringArg(node: RNode | undefined, name: string, position?: number): string | undefined {
	const value = argument(node, name, position)?.value;
	return RString.is(value) ? value.content.str : undefined;
}

function symbolArg(node: RNode | undefined, name: string): string | undefined {
	const value = argument(node, name)?.value;
	return RSymbol.is(value) ? Identifier.getName(value.content) : undefined;
}

/** the variable a plot is assigned to, following `+` and pipe chains up to the assignment */
function assignedName(ids: Ast, id: NodeId): string | undefined {
	let node = ids.get(id);
	while(node?.info.parent !== undefined) {
		const parent = ids.get(node.info.parent);
		if(RArgument.is(parent) || RPipe.is(parent) || (RBinaryOp.is(parent) && Combinators.has(parent.operator)) || (RExpressionList.is(parent) && parent.grouping)) {
			node = parent;
			continue;
		}
		if(!RBinaryOp.is(parent)) {
			return undefined;
		}
		const [value, target] = parent.operator === '->' || parent.operator === '->>' ? [parent.lhs, parent.rhs] : [parent.rhs, parent.lhs];
		return value === node && ['<-', '<<-', '=', '->', '->>'].includes(parent.operator) && RSymbol.is(target) ? Identifier.getName(target.content) : undefined;
	}
	return undefined;
}

const DataArguments = ['data', '.data', 'x', 'df'];

/** the variable a data expression starts from: `df` for `df`, `df$x`, `df |> filter(...)` or `filter(df, ...)` */
function dataOf(node: RNode | undefined, depth = 0): string | undefined {
	if(!node || depth > 20) {
		return undefined;
	} else if(RSymbol.is(node)) {
		return Identifier.getName(node.content);
	} else if(RArgument.is(node)) {
		return dataOf(node.value, depth + 1);
	} else if(RAccess.is(node)) {
		return dataOf(node.accessed, depth + 1);
	} else if(RPipe.is(node) || (RBinaryOp.is(node) && Combinators.has(node.operator))) {
		return dataOf(node.lhs, depth + 1);
	} else if(RExpressionList.is(node) && node.grouping && node.children.length === 1) {
		return dataOf(node.children[0], depth + 1);
	} else if(RFunctionCall.is(node)) {
		return dataOf(inputOf(node), depth + 1);
	}
	return undefined;
}

/** the data a call works on: the left side of the pipe it is in, else its `data`/`x` argument or its first unnamed one */
function inputOf(node: RNode): RNode | undefined {
	if(!RFunctionCall.is(node)) {
		return undefined;
	}
	const args = node.arguments.filter(RArgument.isNotEmpty);
	return (args.find(a => a.name && DataArguments.includes(Identifier.getName(a.name.content))) ?? args.find(a => !a.name))?.value;
}

/**
 * The variables a dependency's data comes from and goes to: `df` and `small` for `small <- df |> filter(x > 1)`,
 * `small` for `write.csv(small, "out.csv")`, and `raw` for `raw <- read.csv("data.csv")`.
 */
export function dataFlowOf(ast: NormalizedAst | undefined, id: NodeId | undefined): { input?: string, output?: string } {
	const node = id === undefined ? undefined : ast?.idMap.get(id);
	if(!ast || !node) {
		return {};
	}
	type Node = RNode<ParentInformation>;
	const parentOf = (n: Node): Node | undefined => n.info.parent === undefined ? undefined : ast.idMap.get(n.info.parent);
	const isPipe = (n: RNode | undefined) => RPipe.is(n) || (RBinaryOp.is(n) && Combinators.has(n.operator));
	let call: Node = node;
	const callParent = parentOf(call);
	if(RFunctionCall.isNamed(callParent) && callParent.functionName === call) {
		call = callParent;
	}
	// flowR may point at the pipe itself or at the call on its right side
	let input: string | undefined;
	if(isPipe(call)) {
		input = dataOf((call as RPipe | RBinaryOp).lhs);
	} else {
		const parent = parentOf(call);
		input = isPipe(parent) && (parent as RPipe<ParentInformation> | RBinaryOp<ParentInformation>).lhs.info.id !== call.info.id ? dataOf((parent as RPipe | RBinaryOp).lhs) : dataOf(inputOf(call));
	}
	return { input, output: assignedName(ast.idMap, call.info.id) };
}

const line = (ids: Ast, id: NodeId | undefined) => id === undefined ? undefined : ids.get(id)?.location?.[0];

/**
 * Describes each plot (the visualizations that others link to, or that link to nothing) by its title
 * (`ggtitle`, `labs(title = )`, `main = `), else the variable it is stored in, plus the file it is saved to
 * (`ggsave`, or a graphics device such as `png()` that is open when it is drawn).
 */
export function describePlots(visualize: readonly DependencyInfo[], writes: readonly DependencyInfo[], ast: NormalizedAst | undefined): Map<DependencyInfo, string> {
	const result = new Map<DependencyInfo, string>();
	if(!ast) {
		return result;
	}
	const ids = ast.idMap;
	const plots = visualize.filter(v => v.nodeId !== undefined && !v.linkedIds?.length);
	const variables = new Map(plots.map(p => [p, assignedName(ids, p.nodeId as NodeId)]));
	const closes = [...ids.values()].filter(n => callName(n) === 'dev.off').map(n => n.location?.[0] ?? 0);

	const files = new Map<DependencyInfo, string>();
	for(const w of writes) {
		const fn = callName(w.nodeId === undefined ? undefined : ids.get(w.nodeId));
		const file = typeof w.value === 'string' ? w.value : undefined;
		const at = line(ids, w.nodeId);
		if(!fn || !file || at === undefined) {
			continue;
		}
		if(fn === 'ggsave') {
			const variable = symbolArg(ids.get(w.nodeId as NodeId), 'plot');
			const target = variable
				? plots.find(p => variables.get(p) === variable)
				: plots.filter(p => (line(ids, p.nodeId) ?? Infinity) <= at).at(-1);
			if(target) {
				files.set(target, file);
			}
		} else if(Devices.has(fn)) {
			const close = closes.filter(c => c > at).sort((a, b) => a - b)[0] ?? Infinity;
			for(const p of plots) {
				const l = line(ids, p.nodeId) ?? -1;
				if(l > at && l < close) {
					files.set(p, file);
				}
			}
		}
	}

	for(const p of plots) {
		const parts = [p, ...visualize.filter(v => p.nodeId !== undefined && v.linkedIds?.includes(p.nodeId))]
			.map(v => v.nodeId === undefined ? undefined : ids.get(v.nodeId));
		const title = parts.map(n => {
			const fn = callName(n);
			return fn === 'ggtitle' ? stringArg(n, 'label', 0) : stringArg(n, fn === 'labs' ? 'title' : 'main');
		}).find(t => t !== undefined);
		const file = files.get(p);
		const name = title !== undefined ? `"${title}"` : variables.get(p);
		if(name || file) {
			result.set(p, [name, file && `→ ${file.split(/[\\/]/).at(-1)}`].filter(Boolean).join(' '));
		}
	}
	return result;
}
