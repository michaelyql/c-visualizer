import type { Node } from "web-tree-sitter";

interface PrintOptions {
    showPositions?: boolean; // include [row,col] ranges
    showText?: boolean; // include source text for leaf/named nodes
    anonymous?: boolean; // include unnamed nodes (punctuation, keywords)
    maxTextLen?: number;
}

export function prettyPrintTree(root: Node, opts: PrintOptions = {}): string {
    const {
        showPositions = true,
        showText = true,
        anonymous = false,
        maxTextLen = 40,
    } = opts;

    const lines: string[] = [];

    const walk = (node: Node, depth: number, fieldName: string | null) => {
        if (!anonymous && !node.isNamed) return;

        const indent = "  ".repeat(depth);
        const field = fieldName ? `${fieldName}: ` : "";

        let pos = "";
        if (showPositions) {
            const s = node.startPosition;
            const e = node.endPosition;
            pos = ` [${s.row},${s.column}] - [${e.row},${e.column}]`;
        }

        // Show text only for leaves (or zero-named-child nodes) to avoid noise
        let text = "";
        if (showText && node.namedChildCount === 0) {
            let t = node.text.replace(/\n/g, "\\n");
            if (t.length > maxTextLen) t = t.slice(0, maxTextLen) + "…";
            text = `  "${t}"`;
        }

        const marker = node.isNamed ? "" : "'";
        lines.push(
            `${indent}${field}${marker}${node.type}${marker}${pos}${text}`
        );

        // Recurse over children, pulling each child's field name from the parent
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child) continue;
            walk(child, depth + 1, node.fieldNameForChild(i));
        }
    };

    walk(root, 0, null);
    return lines.join("\n");
}
