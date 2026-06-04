import { cpp } from "@codemirror/lang-cpp";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import CodeMirror from "@uiw/react-codemirror";

import { linter, type Diagnostic } from "@codemirror/lint";

import { editTree, parseCode } from "../engine/parser";

function syntaxLinter() {
    return linter(
        (view) => {
            const code = view.state.doc.toString();

            const tree = parseCode(code);

            if (!tree) return [];

            const diagnostics: Diagnostic[] = [];

            const cursor = tree.walk();

            let visitedChildren = false;

            while (true) {
                const node = cursor.currentNode;

                // Only report actual ERROR nodes
                if (node.isError && !node.parent?.isError) {
                    diagnostics.push({
                        from: node.startIndex,
                        to: node.endIndex,
                        severity: "error",
                        message: "Syntax error",
                    });
                }

                // Missing tokens
                if (node.isMissing) {
                    diagnostics.push({
                        from: node.startIndex,
                        to: node.endIndex,
                        severity: "error",
                        message: `Expected ${node.type}`,
                    });
                }

                // Only descend into subtrees containing errors
                if (
                    !visitedChildren &&
                    node.hasError &&
                    cursor.gotoFirstChild()
                ) {
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

            return diagnostics;
        },
        // lint config options
        {
            delay: 750, // default delay is 750ms to re-run linter
        }
    );
}

type EditorPaneProps = {
    code: string;
    setCode: (value: string) => void;
    lightMode: boolean;
};

function EditorPane({ code, setCode, lightMode }: EditorPaneProps) {
    return (
        <div className="editor-pane">
            <CodeMirror
                value={code}
                theme={lightMode ? vscodeLight : vscodeDark}
                extensions={[cpp(), syntaxLinter()]}
                onChange={(value, update) => {
                    setCode(value);

                    // update AST
                    update.changes.iterChanges(
                        (fromA, toA, _fromB, toB, _inserted) => {
                            editTree(
                                update.startState.doc,
                                update.state.doc,
                                fromA,
                                toA,
                                toB
                            );
                        }
                    );
                }}
                placeholder={"Enter something to get started!"}
            />
        </div>
    );
}

export default EditorPane;
