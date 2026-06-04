import type { Node, Tree } from "web-tree-sitter";
import { compileProgram } from "./compiler2";
import { parseCode } from "./parser";
import { prettyPrintTree } from "./util";

function collectSyntaxErrors(tree: Tree) {
    const cursor = tree.walk();
    const errors = [];
    let visitedChildren = false;
    while (true) {
        const node: Node = cursor.currentNode;
        if (node.isError || node.type === "ERROR") {
            errors.push({
                type: "ERROR",
                text: node.text,
                start: node.startPosition,
                end: node.endPosition,
            });
        }
        // Missing token inserted by parser recovery
        if (node.isMissing) {
            errors.push({
                type: "MISSING",
                expected: node.type,
                start: node.startPosition,
                end: node.endPosition,
            });
        }
        // Only descend into problematic subtrees
        if (!visitedChildren && node.hasError && cursor.gotoFirstChild()) {
            visitedChildren = false;
            continue;
        }
        if (cursor.gotoNextSibling()) {
            visitedChildren = false;
            continue;
        }
        if (!cursor.gotoParent()) {
            break;
        }
        visitedChildren = true;
    }
    return errors;
}

export function runCode(code: string) {
    // build AST
    const tree = parseCode(code);

    // build IR
    // buildIR(tree);

    // validate IR is well formed
    // no conflicts: type check assignments, no declaring variables in the same scope
    // type check castings
    // otherwise emit errors

    // execute IR step by step

    console.log(
        prettyPrintTree(tree.rootNode, {
            showPositions: true,
            showText: true,
            anonymous: true,
        })
    );

    let functions = compileProgram(tree.rootNode);
    for (let fn of functions) {
        console.log(fn);
    }

    if (!tree) {
        // return {
        //     output: "",
        //     stack: [],
        //     errors: [
        //         {
        //             message: "Parser not initialized",
        //             line: 0,
        //             column: 0,
        //         },
        //     ],
        // };
    }

    const errors = collectSyntaxErrors(tree);

    // if (errors.length > 0) {
    //     return {
    //         output: "",
    //         stack: [],
    //         errors: errors.map((err) => ({
    //             message:
    //                 err.type === "MISSING"
    //                     ? `Expected ${err.expected}`
    //                     : "Syntax error",
    //             line: err.start.row + 1,
    //             column: err.start.column + 1,
    //         })),
    //     };
    // }

    console.log(tree.rootNode.toString());

    // Temporary fake execution
    return {
        // output: "120",
        // stack: [
        //     {
        //         functionName: "main",
        //         scopes: [],
        //     },
        // ],
    };
}
