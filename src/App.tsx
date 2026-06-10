import { useEffect, useState } from "react";
import { initializeParser, parseCode } from "./engine/parser";

import EditorPane from "./components/EditorPane";
import VisualizationPane from "./components/VisualizationPane";

import { compileProgram } from "./engine/compiler";
import { prettyPrintTree } from "./engine/util";
import "./styles.css";

import type { Snapshot } from "./engine/compiler";

const initialCode = `#include <stdio.h>

int factorial(int n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

int main() {
    int x = factorial(5);
    printf("%d\\n", x);
    return 0;
}
`;

function App() {
    const [code, setCode] = useState(initialCode);
    const [lightMode, setLightMode] = useState(false);

    useEffect(() => {
        initializeParser()
            .then(() => {
                console.log("Parser initialized");
            })
            .catch(console.error);
    }, []);

    useEffect(() => {
        document.body.classList.toggle("light-mode", lightMode);
    }, [lightMode]);

    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

    function handleRun() {
        const tree = parseCode(code);
        console.log(tree.rootNode.toString());
        console.log(prettyPrintTree(tree.rootNode, { showText: true }));
        const functions = compileProgram(tree.rootNode);
        for (const fn of functions) {
            console.log(fn);
        }
        // const result = runCode(code);
        // setExecutionState(result);
    }

    function handleReset() {
        setCode(initialCode);
        setSnapshot(null);
    }
    // TODO: Add caching for user's most recently entered code
    // With expiry of 1 week

    return (
        <div className="app">
            <header className="header">
                <span>C Visualizer</span>

                <button
                    className="theme-toggle"
                    onClick={() => setLightMode(!lightMode)}
                    // TODO: change to FontAwesome icons
                >
                    {lightMode ? "🌙" : "☀️"}
                </button>
            </header>

            <div className="toolbar">
                <button className="run-button" onClick={handleRun}>
                    Run
                </button>
                <button className="reset-button" onClick={handleReset}>
                    Reset
                </button>
            </div>

            <div className="main-content">
                <EditorPane
                    code={code}
                    setCode={setCode}
                    lightMode={lightMode}
                />

                <VisualizationPane snapshot={snapshot} />
            </div>
        </div>
    );
}

export default App;
