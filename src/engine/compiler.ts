import type { Node as SyntaxNode } from "web-tree-sitter";

type CType =
    | { kind: "void" }
    | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean }
    | { kind: "float"; bits: 32 | 64 }
    | { kind: "bool" }
    | { kind: "pointer"; to: CType }
    | { kind: "array"; of: CType; length: number | null }
    | { kind: "function"; returns: CType; params: CType[]; variadic: boolean }
    | { kind: "struct"; tag: string | null; members: null } // layout needs the type table
    | { kind: "union"; tag: string | null; members: null }
    | { kind: "enum"; tag: string | null; underlying: CType };

const VOID: CType = { kind: "void" };
const BOOL: CType = { kind: "bool" };
const CHAR: CType = { kind: "int", bits: 8, signed: true };
const INT: CType = { kind: "int", bits: 32, signed: true };
const F64: CType = { kind: "float", bits: 64 };

// ───────────────────────── IR instruction set ─────────────────────────
// Value-stack contract:
//   PUSH_CONST          push rvalue
//   LOAD_ADDR  name     push lvalue {address,type} of a variable
//   LOAD                pop lvalue, push rvalue (decode bytes at address)
//   STORE               stack [.., addr, value] -> write value@addr, push value back
//   BINARY  op          pop rhs, pop lhs, push (lhs op rhs)
//   UNARY   op          pop x, push (op x)
//   INDEX               pop index, pop base(ptr/array), push element lvalue
//   FIELD   offset,type pop struct lvalue, push member lvalue
//   ALLOC   name,t,stor allocate an object in current scope (no value consumed)
//   ENTER/EXIT_SCOPE    push/pop a lexical scope on the current frame
//   JUMP / JUMP_IF_FALSE / JUMP_IF_TRUE   target = local index; *_IF_* pops the test
//   CALL    fn,argc     pop argc args (left→right pushed), push return value
//   RET     hasValue    pop 1 if hasValue; pop the frame
//   POP                 discard top
type Op =
    | { op: "PUSH_CONST"; value: number | string; type: CType }
    | { op: "LOAD_ADDR"; name: string }
    | { op: "LOAD" }
    | { op: "STORE" }
    | { op: "BINARY"; operator: string }
    | { op: "UNARY"; operator: string }
    | { op: "INDEX" }
    | { op: "FIELD"; offset: number; type: CType }
    | {
          op: "ALLOC";
          name: string;
          ctype: CType;
          storage: "static" | "automatic";
      }
    | { op: "ENTER_SCOPE" }
    | { op: "EXIT_SCOPE" }
    | { op: "JUMP"; target: number }
    | { op: "JUMP_IF_FALSE"; target: number }
    | { op: "JUMP_IF_TRUE"; target: number }
    | { op: "CALL"; fn: string; argc: number }
    | { op: "RET"; hasValue: boolean }
    | { op: "POP" };

type Instr = Op & { node: SyntaxNode }; // node = source span, for highlighting

export interface IRFunction {
    name: string;
    params: { name: string; type: CType }[];
    returnType: CType;
    instructions: Instr[];
    variadic: boolean;
}

class CompileError extends Error {
    constructor(message: string, node: SyntaxNode) {
        super(
            `${message} (at ${node.startPosition.row + 1}:${node.startPosition.column + 1}, '${node.type}')`
        );
        this.name = "CompileError";
    }
}

const UNPATCHED = -1;

class FunctionCompiler {
    private code: Instr[] = [];
    private scopeDepth = 0; // nested scopes open beyond the frame base (function body = base)
    private loops: {
        breaks: number[];
        conts: number[];
        breakDepth: number;
        contDepth: number;
    }[] = [];
    private fn: SyntaxNode;

    constructor(fn: SyntaxNode) {
        this.fn = fn;
    }

    private emit(op: Op, node: SyntaxNode): number {
        this.code.push({ ...op, node } as Instr);
        return this.code.length - 1;
    }
    private here(): number {
        return this.code.length;
    }
    private patch(at: number, target: number): void {
        const i = this.code[at];
        if (
            i.op === "JUMP" ||
            i.op === "JUMP_IF_FALSE" ||
            i.op === "JUMP_IF_TRUE"
        )
            i.target = target;
    }

    compile(): IRFunction {
        const base = baseType(this.fn.childForFieldName("type")!);
        const fnDecl = findFunctionDeclarator(
            this.fn.childForFieldName("declarator")!
        );
        if (!fnDecl)
            throw new CompileError("not a function declarator", this.fn);

        const name = declaratorName(fnDecl.childForFieldName("declarator")!);
        const { params, variadic } = this.extractParams(
            fnDecl.childForFieldName("parameters")!
        );
        const returnType = base; // pointer-returning functions (int *f()) not yet applied

        const body = this.fn.childForFieldName("body")!; // function body = the frame's base scope
        this.compileBlockItems(body);

        const last = this.code[this.code.length - 1]; // implicit return if control falls off
        if (!last || last.op !== "RET")
            this.emit({ op: "RET", hasValue: false }, body);

        return { name, params, returnType, instructions: this.code, variadic };
    }

    private extractParams(list: SyntaxNode): {
        params: { name: string; type: CType }[];
        variadic: boolean;
    } {
        const params: { name: string; type: CType }[] = [];
        let variadic = false;
        for (const c of list.namedChildren) {
            if (c.type === "variadic_parameter") {
                variadic = true;
                continue;
            }
            if (c.type !== "parameter_declaration") continue;
            const tNode = c.childForFieldName("type");
            if (!tNode) continue;
            const t = baseType(tNode);
            const d = c.childForFieldName("declarator");
            if (!d) {
                if (t.kind === "void") return { params: [], variadic: false };
                continue;
            }
            params.push({
                name: declaratorName(d),
                type: applyDeclaratorType(t, d),
            });
        }
        return { params, variadic };
    }

    // statements
    private compileBlockItems(block: SyntaxNode): void {
        for (const item of block.namedChildren) {
            if (item.type === "comment") continue;
            this.compileStatement(item);
        }
    }

    private compileStatement(node: SyntaxNode): void {
        switch (node.type) {
            case "comment":
                return;
            case "declaration":
                return this.compileDeclaration(node);
            case "expression_statement":
                return this.compileExprStatement(node);
            case "if_statement":
                return this.compileIf(node);
            case "return_statement":
                return this.compileReturn(node);
            case "while_statement":
                return this.compileWhile(node);
            case "for_statement":
                return this.compileFor(node);
            case "break_statement":
                return this.compileBreak(node);
            case "continue_statement":
                return this.compileContinue(node);
            case "compound_statement":
                this.emit({ op: "ENTER_SCOPE" }, node);
                this.scopeDepth++;
                this.compileBlockItems(node);
                this.emit({ op: "EXIT_SCOPE" }, node);
                this.scopeDepth--;
                return;
            default:
                throw new CompileError(
                    `unsupported statement '${node.type}'`,
                    node
                );
        }
    }

    private declarationStorage(node: SyntaxNode): "static" | "automatic" {
        for (const c of node.children)
            if (
                c.type === "storage_class_specifier" &&
                /static|extern/.test(c.text)
            )
                return "static";
        return "automatic";
    }

    private compileDeclaration(node: SyntaxNode): void {
        const base = baseType(node.childForFieldName("type")!);
        const storage = this.declarationStorage(node);
        for (const d of node.childrenForFieldName("declarator")) {
            if (d.type === "init_declarator") {
                const inner = d.childForFieldName("declarator")!;
                const name = declaratorName(inner);
                this.emit(
                    {
                        op: "ALLOC",
                        name,
                        ctype: applyDeclaratorType(base, inner),
                        storage,
                    },
                    d
                );
                const value = d.childForFieldName("value")!;
                if (value.type === "initializer_list")
                    throw new CompileError(
                        "aggregate/array initializers not yet supported",
                        value
                    );
                this.emit({ op: "LOAD_ADDR", name }, inner); // store the initializer into the new object
                this.compileExpr(value);
                this.emit({ op: "STORE" }, d);
                this.emit({ op: "POP" }, d); // discard the value STORE pushes
            } else {
                const name = declaratorName(d);
                this.emit(
                    {
                        op: "ALLOC",
                        name,
                        ctype: applyDeclaratorType(base, d),
                        storage,
                    },
                    d
                );
            }
        }
    }

    private compileExprStatement(node: SyntaxNode): void {
        const expr = node.namedChildren.find((n) => n.type !== "comment");
        if (!expr) return; // empty statement ';'
        this.compileExpr(expr); // leaves exactly one value
        this.emit({ op: "POP" }, node); // unused
    }

    private compileIf(node: SyntaxNode): void {
        this.compileExpr(node.childForFieldName("condition")!); // parenthesized_expression
        const jf = this.emit({ op: "JUMP_IF_FALSE", target: UNPATCHED }, node);
        this.compileStatement(node.childForFieldName("consequence")!);
        const elseClause = node.childForFieldName("alternative");
        if (elseClause) {
            const jmp = this.emit({ op: "JUMP", target: UNPATCHED }, node);
            this.patch(jf, this.here());
            this.compileStatement(
                elseClause.namedChildren.find((n) => n.type !== "comment")!
            );
            this.patch(jmp, this.here());
        } else {
            this.patch(jf, this.here());
        }
    }

    private compileReturn(node: SyntaxNode): void {
        const value = node.namedChildren.find((n) => n.type !== "comment");
        if (value) this.compileExpr(value);
        this.emit({ op: "RET", hasValue: !!value }, node); // frame-pop discards open scopes
    }

    private compileWhile(node: SyntaxNode): void {
        const depth = this.scopeDepth;
        const condLabel = this.here();
        this.compileExpr(node.childForFieldName("condition")!);
        const exit = this.emit(
            { op: "JUMP_IF_FALSE", target: UNPATCHED },
            node
        );
        this.loops.push({
            breaks: [],
            conts: [],
            breakDepth: depth,
            contDepth: depth,
        });
        this.compileStatement(node.childForFieldName("body")!);
        this.emit({ op: "JUMP", target: condLabel }, node);
        this.patch(exit, this.here());
        const end = this.here();
        const ctx = this.loops.pop()!;
        ctx.conts.forEach((j) => this.patch(j, condLabel));
        ctx.breaks.forEach((j) => this.patch(j, end));
    }

    private compileFor(node: SyntaxNode): void {
        const outer = this.scopeDepth;
        this.emit({ op: "ENTER_SCOPE" }, node);
        this.scopeDepth++; // for-header scope
        const headerDepth = this.scopeDepth;

        const init = node.childForFieldName("initializer");
        if (init) {
            if (init.type === "declaration") this.compileDeclaration(init);
            else {
                this.compileExpr(init);
                this.emit({ op: "POP" }, init);
            }
        }
        const condLabel = this.here();
        const cond = node.childForFieldName("condition");
        let exit = UNPATCHED;
        if (cond) {
            this.compileExpr(cond);
            exit = this.emit({ op: "JUMP_IF_FALSE", target: UNPATCHED }, cond);
        }

        this.loops.push({
            breaks: [],
            conts: [],
            breakDepth: outer,
            contDepth: headerDepth,
        });
        this.compileStatement(node.childForFieldName("body")!);

        const contTarget = this.here();
        const update = node.childForFieldName("update");
        if (update) {
            this.compileExpr(update);
            this.emit({ op: "POP" }, update);
        }
        this.emit({ op: "JUMP", target: condLabel }, node);

        if (exit !== UNPATCHED) this.patch(exit, this.here());
        this.emit({ op: "EXIT_SCOPE" }, node);
        this.scopeDepth--; // normal-exit path leaves header scope
        const end = this.here(); // break lands here, already unwound
        const ctx = this.loops.pop()!;
        ctx.conts.forEach((j) => this.patch(j, contTarget));
        ctx.breaks.forEach((j) => this.patch(j, end));
    }

    private compileBreak(node: SyntaxNode): void {
        const ctx = this.loops[this.loops.length - 1];
        if (!ctx) throw new CompileError("break outside loop", node);
        for (let d = this.scopeDepth; d > ctx.breakDepth; d--)
            this.emit({ op: "EXIT_SCOPE" }, node);
        ctx.breaks.push(this.emit({ op: "JUMP", target: UNPATCHED }, node));
    }
    private compileContinue(node: SyntaxNode): void {
        const ctx = this.loops[this.loops.length - 1];
        if (!ctx) throw new CompileError("continue outside loop", node);
        for (let d = this.scopeDepth; d > ctx.contDepth; d--)
            this.emit({ op: "EXIT_SCOPE" }, node);
        ctx.conts.push(this.emit({ op: "JUMP", target: UNPATCHED }, node));
    }

    // expressions (rvalue)
    private compileExpr(node: SyntaxNode): void {
        switch (node.type) {
            case "number_literal": {
                const { value, ctype } = parseNumber(node.text);
                return void this.emit(
                    {
                        op: "PUSH_CONST",
                        value,
                        type: ctype === "double" ? F64 : INT,
                    },
                    node
                );
            }
            case "char_literal":
                return void this.emit(
                    { op: "PUSH_CONST", value: charValue(node), type: CHAR },
                    node
                );
            case "string_literal":
            case "concatenated_string":
                return void this.emit(
                    {
                        op: "PUSH_CONST",
                        value: stringValue(node),
                        type: { kind: "pointer", to: CHAR },
                    },
                    node
                );
            case "true":
                return void this.emit(
                    { op: "PUSH_CONST", value: 1, type: BOOL },
                    node
                );
            case "false":
                return void this.emit(
                    { op: "PUSH_CONST", value: 0, type: BOOL },
                    node
                );
            case "null":
                return void this.emit(
                    {
                        op: "PUSH_CONST",
                        value: 0,
                        type: { kind: "pointer", to: VOID },
                    },
                    node
                );
            case "identifier":
                this.emit({ op: "LOAD_ADDR", name: node.text }, node);
                return void this.emit({ op: "LOAD" }, node);
            case "parenthesized_expression":
                return this.compileExpr(this.innerExpr(node));
            case "comma_expression":
                this.compileExpr(node.childForFieldName("left")!);
                this.emit({ op: "POP" }, node);
                return this.compileExpr(node.childForFieldName("right")!);
            case "binary_expression":
                return this.compileBinary(node);
            case "unary_expression":
                this.compileExpr(node.childForFieldName("argument")!);
                return void this.emit(
                    {
                        op: "UNARY",
                        operator: node.childForFieldName("operator")!.text,
                    },
                    node
                );
            case "pointer_expression": {
                const op = node.childForFieldName("operator")!.text;
                if (op === "&")
                    return this.compileLValue(
                        node.childForFieldName("argument")!
                    ); // address-of
                this.compileExpr(node.childForFieldName("argument")!); // '*' deref
                return void this.emit({ op: "LOAD" }, node);
            }
            case "subscript_expression":
            case "field_expression":
                this.compileLValue(node);
                return void this.emit({ op: "LOAD" }, node);
            case "call_expression":
                return this.compileCall(node);
            case "assignment_expression":
                return this.compileAssignment(node);
            case "update_expression":
                return this.compileUpdate(node);
            case "conditional_expression":
                return this.compileTernary(node);
            case "cast_expression":
                return this.compileExpr(node.childForFieldName("value")!); // no-op (needs CONVERT)
            default:
                throw new CompileError(
                    `unsupported expression '${node.type}'`,
                    node
                );
        }
    }

    // expressions (lvalue / address)
    private compileLValue(node: SyntaxNode): void {
        switch (node.type) {
            case "identifier":
                return void this.emit(
                    { op: "LOAD_ADDR", name: node.text },
                    node
                );
            case "parenthesized_expression":
                return this.compileLValue(this.innerExpr(node));
            case "pointer_expression":
                if (node.childForFieldName("operator")!.text === "*")
                    return this.compileExpr(
                        node.childForFieldName("argument")!
                    ); // pointer value IS the address
                throw new CompileError("&expr is not an lvalue", node);
            case "subscript_expression":
                this.compileExpr(node.childForFieldName("argument")!); // NOTE: array→pointer decay not modeled
                this.compileExpr(node.childForFieldName("index")!);
                return void this.emit({ op: "INDEX" }, node);
            case "field_expression":
                throw new CompileError(
                    "struct field access needs struct layout from the type table (not yet wired)",
                    node
                );
            default:
                throw new CompileError(`'${node.type}' is not an lvalue`, node);
        }
    }

    private compileBinary(node: SyntaxNode): void {
        const op = node.childForFieldName("operator")!.text;
        const left = node.childForFieldName("left")!;
        const right = node.childForFieldName("right")!;
        if (op === "&&" || op === "||") {
            // short-circuit, yields canonical 0/1
            const shortJump: "JUMP_IF_FALSE" | "JUMP_IF_TRUE" =
                op === "&&" ? "JUMP_IF_FALSE" : "JUMP_IF_TRUE";
            const shortVal = op === "&&" ? 0 : 1;
            this.compileExpr(left);
            const j1 = this.emit({ op: shortJump, target: UNPATCHED }, node);
            this.compileExpr(right);
            const j2 = this.emit({ op: shortJump, target: UNPATCHED }, node);
            this.emit(
                { op: "PUSH_CONST", value: 1 - shortVal, type: BOOL },
                node
            );
            const jEnd = this.emit({ op: "JUMP", target: UNPATCHED }, node);
            const shortLabel = this.here();
            this.patch(j1, shortLabel);
            this.patch(j2, shortLabel);
            this.emit({ op: "PUSH_CONST", value: shortVal, type: BOOL }, node);
            this.patch(jEnd, this.here());
            return;
        }
        this.compileExpr(left);
        this.compileExpr(right);
        this.emit({ op: "BINARY", operator: op }, node);
    }

    private compileAssignment(node: SyntaxNode): void {
        const left = node.childForFieldName("left")!;
        const op = node.childForFieldName("operator")!.text;
        const right = node.childForFieldName("right")!;
        if (op === "=") {
            this.compileLValue(left);
            this.compileExpr(right);
            return void this.emit({ op: "STORE" }, node); // STORE pushes value back (assignment is an expression)
        }
        // compound (+=, -=, ...): identifier lvalues only (no side effects in addressing)
        if (left.type !== "identifier")
            throw new CompileError(
                `compound assignment '${op}' only supported on simple variables for now`,
                left
            );
        const name = left.text;
        this.emit({ op: "LOAD_ADDR", name }, left); // addr for STORE
        this.emit({ op: "LOAD_ADDR", name }, left); // addr for read
        this.emit({ op: "LOAD" }, left);
        this.compileExpr(right);
        this.emit({ op: "BINARY", operator: op.slice(0, -1) }, node);
        this.emit({ op: "STORE" }, node);
    }

    private compileUpdate(node: SyntaxNode): void {
        // NOTE: compiled as pre-inc/dec (yields the NEW value). Correct as a statement or for-update
        // (result discarded). Using i++ inside a larger expression needs a DUP op for old-value semantics.
        const arg = node.childForFieldName("argument")!;
        const op = node.childForFieldName("operator")!.text; // '++' | '--'
        if (arg.type !== "identifier")
            throw new CompileError(
                `'${op}' only supported on simple variables for now`,
                arg
            );
        const name = arg.text;
        this.emit({ op: "LOAD_ADDR", name }, node);
        this.emit({ op: "LOAD_ADDR", name }, node);
        this.emit({ op: "LOAD" }, node);
        this.emit({ op: "PUSH_CONST", value: 1, type: INT }, node);
        this.emit({ op: "BINARY", operator: op === "++" ? "+" : "-" }, node);
        this.emit({ op: "STORE" }, node);
    }

    private compileTernary(node: SyntaxNode): void {
        this.compileExpr(node.childForFieldName("condition")!);
        const jf = this.emit({ op: "JUMP_IF_FALSE", target: UNPATCHED }, node);
        this.compileExpr(node.childForFieldName("consequence")!);
        const jmp = this.emit({ op: "JUMP", target: UNPATCHED }, node);
        this.patch(jf, this.here());
        this.compileExpr(node.childForFieldName("alternative")!);
        this.patch(jmp, this.here());
    }

    private compileCall(node: SyntaxNode): void {
        const fnNode = node.childForFieldName("function")!;
        if (fnNode.type !== "identifier")
            throw new CompileError(
                "only direct calls by name are supported (function pointers not yet)",
                fnNode
            );
        const argList = node.childForFieldName("arguments")!;
        let argc = 0;
        for (const a of argList.namedChildren) {
            if (a.type === "comment") continue;
            if (a.type === "compound_statement")
                throw new CompileError(
                    "statement-expression arguments not supported",
                    a
                );
            this.compileExpr(a);
            argc++; // pushed left→right
        }
        this.emit({ op: "CALL", fn: fnNode.text, argc }, node);
    }

    private innerExpr(paren: SyntaxNode): SyntaxNode {
        const c = paren.namedChildren.find((n) => n.type !== "comment");
        if (!c) throw new CompileError("empty parentheses", paren);
        if (c.type === "compound_statement")
            throw new CompileError(
                "statement expressions ({...}) not supported",
                c
            );
        return c;
    }
}

// helpers
function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
    if (node.type === "function_declarator") return node;
    const inner = node.childForFieldName("declarator");
    return inner ? findFunctionDeclarator(inner) : null;
}

function declaratorName(node: SyntaxNode): string {
    switch (node.type) {
        case "identifier":
        case "field_identifier":
        case "type_identifier":
            return node.text;
        case "parenthesized_declarator": {
            for (let i = node.namedChildren.length - 1; i >= 0; i--) {
                const c = node.namedChildren[i];
                if (c.type !== "ms_call_modifier" && c.type !== "comment")
                    return declaratorName(c);
            }
            throw new CompileError("empty parenthesized declarator", node);
        }
        default: {
            const inner = node.childForFieldName("declarator");
            if (inner) return declaratorName(inner);
            throw new CompileError(
                `cannot extract name from '${node.type}'`,
                node
            );
        }
    }
}

function applyDeclaratorType(base: CType, node: SyntaxNode): CType {
    switch (node.type) {
        case "identifier":
        case "field_identifier":
        case "type_identifier":
            return base;
        case "pointer_declarator":
            return applyDeclaratorType(
                { kind: "pointer", to: base },
                node.childForFieldName("declarator")!
            );
        case "array_declarator": {
            const sz = node.childForFieldName("size");
            const length =
                sz && sz.type === "number_literal"
                    ? parseNumber(sz.text).value
                    : null;
            return applyDeclaratorType(
                { kind: "array", of: base, length },
                node.childForFieldName("declarator")!
            );
        }
        case "function_declarator":
            return applyDeclaratorType(
                {
                    kind: "function",
                    returns: base,
                    params: [],
                    variadic: false,
                },
                node.childForFieldName("declarator")!
            );
        default:
            return base; // attributed_declarator / parenthesized: complex nesting not fully modeled
    }
}

function baseType(spec: SyntaxNode): CType {
    switch (spec.type) {
        case "primitive_type":
            return primitiveToCType(spec.text, spec);
        case "sized_type_specifier":
            return sizedToCType(spec);
        case "type_identifier":
            throw new CompileError(
                `typedef '${spec.text}' needs the typedef table (not yet wired)`,
                spec
            );
        case "struct_specifier":
        case "union_specifier":
        case "enum_specifier":
            throw new CompileError(
                `'${spec.type}' needs the tag table for layout (not yet wired)`,
                spec
            );
        default:
            throw new CompileError(
                `unknown type specifier '${spec.type}'`,
                spec
            );
    }
}

function primitiveToCType(text: string, node: SyntaxNode): CType {
    switch (text) {
        case "void":
            return VOID;
        case "bool":
            return BOOL;
        case "char":
            return { kind: "int", bits: 8, signed: true };
        case "short":
            return { kind: "int", bits: 16, signed: true };
        case "int":
            return INT;
        case "long":
            return { kind: "int", bits: 64, signed: true };
        case "float":
            return { kind: "float", bits: 32 };
        case "double":
            return F64;
        case "size_t":
        case "uintptr_t":
            return { kind: "int", bits: 64, signed: false };
        case "ssize_t":
        case "ptrdiff_t":
        case "intptr_t":
            return { kind: "int", bits: 64, signed: true };
    }
    let m = /^u?int(\d+)_t$/.exec(text);
    if (m)
        return {
            kind: "int",
            bits: +m[1] as 8 | 16 | 32 | 64,
            signed: !text.startsWith("u"),
        };
    throw new CompileError(`unsupported primitive type '${text}'`, node);
}

function sizedToCType(spec: SyntaxNode): CType {
    const words = spec.children
        .filter(
            (c) =>
                /^(signed|unsigned|long|short)$/.test(c.type) ||
                /^(signed|unsigned|long|short)$/.test(c.text)
        )
        .map((c) => c.text);
    const tNode = spec.childForFieldName("type");
    if (
        tNode &&
        tNode.type === "primitive_type" &&
        /float|double/.test(tNode.text)
    )
        return primitiveToCType(tNode.text, tNode);
    const signed = !words.includes("unsigned");
    let bits: 8 | 16 | 32 | 64 = 32;
    if (words.includes("short")) bits = 16;
    else if (words.filter((w) => w === "long").length >= 1) bits = 64;
    if (tNode && tNode.type === "primitive_type" && tNode.text === "char")
        bits = 8;
    return { kind: "int", bits, signed };
}

function parseNumber(text: string): { value: number; ctype: "int" | "double" } {
    let t = text.trim();
    const hex = /^[-+]?0[xX]/.test(t);
    const isFloat =
        t.includes(".") ||
        /[fF]$/.test(t) ||
        (!hex && /[eE]/.test(t)) ||
        (hex && /[pP]/.test(t));

    t = hex ? t.replace(/[uUlL]+/, "") : t.replace(/[uUlLfF]+/, "");
    return { value: Number(t), ctype: isFloat ? "double" : "int" };
}

function unescapeC(s: string): string {
    return s.replace(
        /\\(x[0-9a-fA-F]{1,4}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/g,
        (_, e: string) => {
            if (e[0] === "x")
                return String.fromCharCode(parseInt(e.slice(1), 16));
            if (e[0] === "u" || e[0] === "U")
                return String.fromCodePoint(parseInt(e.slice(1), 16));
            if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
            return (
                (
                    {
                        n: "\n",
                        t: "\t",
                        r: "\r",
                        "\\": "\\",
                        "'": "'",
                        '"': '"',
                        a: "\x07",
                        b: "\b",
                        f: "\f",
                        v: "\v",
                    } as Record<string, string>
                )[e] ?? e
            );
        }
    );
}

function stringValue(node: SyntaxNode): string {
    if (node.type === "concatenated_string")
        return node.namedChildren
            .filter((c) => c.type === "string_literal")
            .map(stringValue)
            .join("");
    return unescapeC(node.text.replace(/^(L|u8|u|U)?"/, "").replace(/"$/, ""));
}
function charValue(node: SyntaxNode): number {
    const inner = node.text.replace(/^(L|u8|u|U)?'/, "").replace(/'$/, "");
    return unescapeC(inner).codePointAt(0) ?? 0;
}

// usage:
//   const funcs  = compileProgram(tree.rootNode);
//   const byName = new Map(funcs.map(f => [f.name, f]));
//   // VM frame: { fn: IRFunction; pc: number; ... };  CALL -> byName.get(fn) or a builtin (printf).
export function compileProgram(root: SyntaxNode): IRFunction[] {
    const fns: IRFunction[] = [];
    for (const item of root.namedChildren) {
        if (item.type === "function_definition")
            fns.push(new FunctionCompiler(item).compile());
        // file-scope declarations/typedefs/tags: handle in a separate hoisting pre-pass
        // that also populates the compile-time type table this compiler will need for structs.
    }
    return fns;
}
