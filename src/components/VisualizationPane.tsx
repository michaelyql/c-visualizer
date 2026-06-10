import type { Snapshot } from "../engine/compiler";

type VisualizationPaneProps = {
    snapshot: Snapshot | null;
};

function VisualizationPane({ snapshot }: VisualizationPaneProps) {
    if (!snapshot) {
        return (
            <div className="visualization-pane">Press Run to execute code.</div>
        );
    }

    // Render syntax/runtime errors
    // if (snapshot.errors && snapshot.errors.length > 0) {
    //     return (
    //         <div className="visualization-pane">
    //             <h2 className="visualization-error-title">Errors</h2>

    //             {executionState.errors.map((error, index) => (
    //                 <div key={index} className="visualization-error-card">
    //                     <div>
    //                         <strong>{error.message}</strong>
    //                     </div>

    //                     <div className="visualization-error-location">
    //                         Line {error.line}, Column {error.column}
    //                     </div>
    //                 </div>
    //             ))}
    //         </div>
    //     );
    // }

    return (
        <div className="visualization-pane">
            <h2>Program Output</h2>

            {/* <pre>{executionState.output}</pre> */}

            <h2>Stack</h2>
            {/* 
            {executionState.stack.map((frame, index) => (
                <div key={index} className="visualization-stack-frame">
                    <strong>{frame.functionName}</strong>

                    <div className="visualization-stack-variables">
                        {frame.scopes.map((scope, i) => (
                            <div key={i}>
                                {scope.name} = {variable.value}
                            </div>
                        ))}
                    </div>
                </div>
            ))} */}
        </div>
    );
}

export default VisualizationPane;
