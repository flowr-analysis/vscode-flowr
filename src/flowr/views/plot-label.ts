import type { DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { NormalizedAst, ParentInformation } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { RFunctionCall } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-function-call';
import { RArgument } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-argument';
import { RSymbol } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-symbol';
import { RBinaryOp } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-binary-op';
import { RPipe } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-pipe';
import { RExpressionList } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-expression-list';
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';

const Combinators = new Set(['+', '%>%', '|>']);

/** the variable a call is assigned to, following `+` and pipe chains up to the assignment */
function assignedName(ast: NormalizedAst, id: NodeId): string | undefined {
	const ids = ast.idMap;
	let node: RNode<ParentInformation> | undefined = ids.get(id);
	// flowR may point at the called name instead of the call
	const callParent = node?.info.parent === undefined ? undefined : ids.get(node.info.parent);
	if(RFunctionCall.isNamed(callParent) && callParent.functionName === node) {
		node = callParent;
	}
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

/**
 * The variable a dependency's result is assigned to: flowR's `assignedTo`, else found in the AST, as flowR does not
 * follow every chain yet (a `+` chain of a ggplot, `%>%`, or a call piped into another one).
 */
function assignedTo(ast: NormalizedAst | undefined, info: DependencyInfo): string | undefined {
	return info.assignedTo ?? (ast && info.nodeId !== undefined ? assignedName(ast, info.nodeId) : undefined);
}

/**
 * The variables a dependency's data comes from and goes to: `df` and `small` for `small <- df |> filter(x > 1)`,
 * `small` for `write.csv(small, "out.csv")`, and `raw` for `raw <- read.csv("data.csv")`.
 */
export function dataFlowOf(ast: NormalizedAst | undefined, info: DependencyInfo): { inputs: readonly string[], output?: string } {
	return { inputs: info.inputVariables ?? [], output: assignedTo(ast, info) };
}

/**
 * Describes each plot (the visualizations that others link to, or that link to nothing) by the title flowR found
 * (`ggtitle`, `labs(title = )`, `main = `), else the variable it is stored in, plus the file it is saved to.
 */
export function describePlots(visualize: readonly DependencyInfo[], ast: NormalizedAst | undefined): Map<DependencyInfo, string> {
	const result = new Map<DependencyInfo, string>();
	for(const p of visualize.filter(v => v.nodeId !== undefined && !v.linkedIds?.length)) {
		const name = p.title !== undefined ? `"${p.title}"` : assignedTo(ast, p);
		const file = p.savedTo;
		if(name || file) {
			result.set(p, [name, file && `→ ${file.split(/[\\/]/).at(-1)}`].filter(Boolean).join(' '));
		}
	}
	return result;
}
