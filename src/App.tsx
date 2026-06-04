import { useEffect, useState } from "react";
import { initializeParser } from "./engine/parser";

import EditorPane from "./components/EditorPane";
import VisualizationPane from "./components/VisualizationPane";

import { runCode } from "./engine/interpreter";
import { type ExecutionState } from "./engine/types";

import "./styles.css";

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

    const [executionState, setExecutionState] = useState<ExecutionState | null>(
        null
    );

    function handleRun() {
        const result = runCode(code);
        // setExecutionState(result);
    }

    function handleReset() {
        setCode(initialCode);
        setExecutionState(null);
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

                <VisualizationPane executionState={executionState} />
            </div>
        </div>
    );
}

export default App;
