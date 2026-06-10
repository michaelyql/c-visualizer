import type { Text } from "@uiw/react-codemirror";
import { Edit, Language, Parser, type Point, type Tree } from "web-tree-sitter";

let parser: Parser | null = null;
let C: Language | null = null;
let oldTree: Tree | null = null;

export async function initializeParser() {
    await Parser.init({
        locateFile(scriptName: string) {
            scriptName;
            // tells the WASM loader where to find web-tree-sitter.wasm
            return "/c-visualizer/tree-sitter/web-tree-sitter.wasm";
        },
    });

    C = await Language.load("/c-visualizer/tree-sitter/tree-sitter-c.wasm");

    parser = new Parser();
    parser.setLanguage(C);
}

function pointAt(doc: Text, index: number): Point {
    const line = doc.lineAt(index);

    return {
        row: line.number - 1,
        column: index - line.from,
    };
}

export function editTree(
    oldDoc: Text,
    newDoc: Text,
    from: number,
    oldTo: number,
    newTo: number
) {
    if (!oldTree) return;

    let e = new Edit({
        startIndex: from,
        oldEndIndex: oldTo,
        newEndIndex: newTo,
        startPosition: pointAt(oldDoc, from),
        oldEndPosition: pointAt(oldDoc, oldTo),
        newEndPosition: pointAt(newDoc, newTo),
    });

    oldTree.edit(e);
}

export function parseCode(code: string) {
    if (!parser) {
        throw new Error("Parser not initialized");
    }

    const tree = parser.parse(code, oldTree);

    if (!tree) {
        throw new Error("Parse aborted unexpectedly");
    }

    oldTree = tree;

    return tree;
}
