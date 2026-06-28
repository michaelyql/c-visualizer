import type { Node as SyntaxNode } from "web-tree-sitter";

import type { RegionId } from "./memory";

// member field of struct/union
export interface Member {
    name: string;
    type: CType;
    offset: number; // byte offset within the aggregate, assigned at layout
}

export type CType =
    | { kind: "void" }
    | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean } // char/short/int/long
    | { kind: "float"; bits: 32 | 64 } // float/double
    | { kind: "bool" }
    | { kind: "pointer"; to: CType }
    | { kind: "array"; of: CType; length: number | null } // null = incomplete: int a[]
    | { kind: "function"; returns: CType; params: CType[]; variadic: boolean }
    | {
          kind: "struct";
          tag: string | null;
          members: Member[] | null;
          size: number | null;
          align: number | null;
      }
    | {
          kind: "union";
          tag: string | null;
          members: Member[] | null;
          size: number | null;
          align: number | null;
      }
    | {
          kind: "enum";
          tag: string | null;
          underlying: { kind: "int"; bits: 32; signed: true }; // always int for C99
      };

const VOID: CType = { kind: "void" };
const BOOL: CType = { kind: "bool" };
const CHAR: CType = { kind: "int", bits: 8, signed: true };
const INT: CType = { kind: "int", bits: 32, signed: true };
const F64: CType = { kind: "float", bits: 64 };

type AggregateType = Extract<CType, { kind: "struct" | "union" }>;

interface ModuleCtx {
    typedefs: Map<string, CType>;
    tags: Map<string, CType>;
    enumerators: Map<string, { value: number; type: CType }>;
}

// Live byte window of one region + its init bits, bounded by the bump pointer
// so the copy cost is proportional to live size, not the region cap.
interface RegionImage {
    bytes: Uint8Array; // copy of the live range
    initMask: Uint8Array; // copy of init bits over the same range
    next: number; // bump pointer (defines the live range when sliced)
}

export type Status =
    | { kind: "running" }
    | { kind: "halted"; exitCode: number }
    | { kind: "fault"; reason: string; addr?: number };

export interface MemObject {
    address: number;
    type: CType;
    name?: string; // named variable; absent for heap/anonymous
    region: RegionId;
    size: number;
    lifecycle: "alive" | "freed"; // freed kept (addresses never reused) for UAF
}

interface ScopeView {
    bindings: Map<string, number>;
} // name -> address
interface FrameView {
    func: string;
    scopes: ScopeView[];
} // innermost scope last

export interface Snapshot {
    regions: Record<RegionId, RegionImage>;
    objects: Map<number, MemObject>; // keyed by address; grows monotonically
    frames: FrameView[]; // call stack, index 0 = main
    highlight: { startByte: number; endByte: number } | null; // source span
    stdout: string; // output accumulated so far
    status: Status;
}

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
          offset: number;
      }
    | { op: "ENTER_SCOPE" }
    | { op: "EXIT_SCOPE" }
    | { op: "JUMP"; target: number }
    | { op: "JUMP_IF_FALSE"; target: number }
    | { op: "JUMP_IF_TRUE"; target: number }
    | { op: "CALL"; fn: string; argc: number }
    | { op: "RET"; hasValue: boolean }
    | { op: "POP" };

export type Instr = Op & { node: SyntaxNode }; // node = source span, for highlighting

export interface IRFunction {
    name: string;
    params: { name: string; type: CType; offset: number }[];
    returnType: CType;
    instructions: Instr[];
    variadic: boolean;
    frameSize: number;
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

const roundUp = (n: number, a: number) => Math.ceil(n / a) * a;

class FunctionCompiler {
    private code: Instr[] = [];
    private scopeDepth = 0; // nested scopes open beyond the frame base (function body = base)
    private loops: {
        breaks: number[];
        conts: number[];
        breakDepth: number;
        contDepth: number;
    }[] = [];
    private fn: SyntaxNode | null;
    private synthName: string | null = null; // set for compiler-generated fns (@init)
    private fallback: SyntaxNode | null = null; // span for synthetic instructions
    private frameCursor = 0; // next free byte offset in the current frame
    private frameSize = 0; // high-water mark over all scopes = frame size
    private scopeMarks: number[] = []; // saved cursors for structural scope nesting

    private ctx: ModuleCtx;

    constructor(fn: SyntaxNode | null, ctx: ModuleCtx) {
        this.fn = fn;
        this.ctx = ctx;
    }

    // A compiler-generated function with no source declarator (e.g. @init for globals).
    // `fallback` supplies a source span for any synthetic instruction (the trailing RET).
    static synthetic(
        name: string,
        ctx: ModuleCtx,
        fallback: SyntaxNode
    ): FunctionCompiler {
        const fc = new FunctionCompiler(null, ctx);
        fc.synthName = name;
        fc.fallback = fallback;
        return fc;
    }

    /**
     * Compiles a `function_definition` node.
     *
     * Function declarations are handled separately and should not call this,
     * as it expects the node to have a function body.
     *
     * @returns An `IRFunction`
     */
    compile(): IRFunction {
        if (!this.fn)
            throw new Error("compile() on a synthetic compiler; use finish()");

        const returnType = baseType(
            this.fn.childForFieldName("type")!,
            this.ctx
        );
        const decl = this.fn.childForFieldName("declarator")!;

        if (decl.type != "function_declarator")
            throw new CompileError("not a function declarator", this.fn);

        const name = declaratorName(decl.childForFieldName("declarator")!);
        const { params: rawParams, variadic } = this.extractParams(
            decl.childForFieldName("parameters")!
        );
        const params = this.layoutParams(rawParams); // leading frame slots; seeds the cursor
        const body = this.fn.childForFieldName("body")!;
        this.compileBlockItems(body);
        this.ensureTrailingRet(body);
        return {
            name,
            params,
            returnType,
            instructions: this.code,
            variadic,
            frameSize: this.frameSize,
        };
    }

    /**
     * Attaches an offset to each parameter and sets `frameSize` and `frameCursor` to the total stack space
     * @param raw List of parameters
     * @returns List of parameters with their computed offset from the base pointer of the function
     */
    private layoutParams(
        raw: { name: string; type: CType }[]
    ): { name: string; type: CType; offset: number }[] {
        let cursor = 0;
        const out = raw.map((p) => {
            const a = alignOf(p.type);
            cursor = roundUp(cursor, a);
            const offset = cursor;
            cursor += sizeOf(p.type);
            return { ...p, offset };
        });
        this.frameCursor = cursor;
        this.frameSize = cursor;
        return out;
    }

    /**
     * Ensures that a function always has a return value (defaults to `void` if none)
     * @param node A `return_statement` node
     */
    private ensureTrailingRet(node: SyntaxNode): void {
        const last = this.code[this.code.length - 1];
        if (!last || last.op !== "RET")
            this.emit({ op: "RET", hasValue: false }, node);
    }

    hasInstructions(): boolean {
        return this.code.length > 0;
    }

    // Build the IRFunction for a synthetic function (void, no params).
    finish(): IRFunction {
        this.ensureTrailingRet(this.fallback!);
        return {
            name: this.synthName!,
            params: [],
            returnType: VOID,
            instructions: this.code,
            variadic: false,
            frameSize: this.frameSize,
        };
    }

    /**
     * Compiles a declaration statement and pushes an instruction onto the instruction list
     * @param node A `declaration` node
     */
    private compileDeclaration(node: SyntaxNode): void {
        this.emitDeclaration(node, this.declarationStorage(node), false);
    }

    // File-scope variables have static storage; a bare prototype (int foo(int);)
    // declares no storage and is skipped — calls resolve by name at runtime.
    compileGlobalDeclaration(node: SyntaxNode): void {
        this.emitDeclaration(node, "static", true);
    }

    /**
     *
     * @param node A `declaration` node
     * @param storage Storage duration (static/automatic)
     * @param skipFunctionDecls Whether or not to skip function declarations
     */
    private emitDeclaration(
        node: SyntaxNode,
        storage: "static" | "automatic",
        skipFunctionDecls: boolean
    ): void {
        const base = baseType(node.childForFieldName("type")!, this.ctx);

        // May have multiple declarators
        for (const d of node.childrenForFieldName("declarator")) {
            const inner =
                d.type === "init_declarator"
                    ? d.childForFieldName("declarator")!
                    : d;
            const ctype = applyDeclaratorType(base, inner);

            if (skipFunctionDecls && ctype.kind === "function") continue;
            const name = declaratorName(inner);

            let offset = 0;

            // Update frameCursor and frameSize if stack-based
            if (storage === "automatic") {
                const a = alignOf(ctype);
                this.frameCursor = roundUp(this.frameCursor, a);
                offset = this.frameCursor;
                this.frameCursor += sizeOf(ctype);
                if (this.frameCursor > this.frameSize)
                    this.frameSize = this.frameCursor;
            }

            // Allocate stack space (if automatic storage duration)
            this.emit({ op: "ALLOC", name, ctype, storage, offset }, d);

            // Load variable -> evaluate expression -> store expression value into variable -> pop expression value
            if (d.type === "init_declarator") {
                const value = d.childForFieldName("value")!;
                if (value.type === "initializer_list")
                    throw new CompileError(
                        "aggregate/array initializers not yet supported",
                        value
                    );
                this.emit({ op: "LOAD_ADDR", name }, inner);
                this.compileExpr(value);
                this.emit({ op: "STORE" }, d);
                this.emit({ op: "POP" }, d);
            }
        }
    }

    /**
     * Pushes an operation into the instruction list
     * @param op An `Op` from the custom instruction set
     * @param node The node that produces this instruction
     * @returns The index of the instruction in the instruction list
     */
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

    /**
     * Extracts parameters from a parameter list.
     * @param list A `parameter_list` node
     */
    private extractParams(list: SyntaxNode): {
        params: { name: string; type: CType }[];
        variadic: boolean;
    } {
        const children = list.namedChildren.filter(
            (c) =>
                c.type === "parameter_declaration" ||
                c.type === "variadic_parameter"
        );

        // fn() -> unspecified argument count
        if (children.length === 0) {
            return { params: [], variadic: true };
        }

        // fn(void) -> exactly zero parameters
        const only = children[0];
        if (
            children.length === 1 &&
            only.type === "parameter_declaration" &&
            baseType(only.childForFieldName("type")!, this.ctx).kind ===
                "void" &&
            !only.childForFieldName("declarator") // void param cannot be named
        ) {
            return { params: [], variadic: false };
        }

        const params: { name: string; type: CType }[] = [];
        let variadic = false;

        for (let i = 0; i < children.length; i++) {
            const c = children[i];

            if (c.type === "variadic_parameter") {
                // C99: '...' must follow >=1 named parameter and be last
                if (i === 0) {
                    throw new CompileError(
                        "error: ISO C requires a named parameter before '...'",
                        c
                    );
                }
                if (i !== children.length - 1) {
                    throw new CompileError(
                        "error: '...' must be the last parameter",
                        c
                    );
                }
                variadic = true;
                continue;
            }

            // parameter_declaration
            const tNode = c.childForFieldName("type");
            if (!tNode) continue;
            const t = baseType(tNode, this.ctx);
            const d = c.childForFieldName("declarator");

            // void is only legal as the sole, unnamed parameter (handled above);
            // reaching here means it's mixed with others or named
            if (t.kind === "void" && !d) {
                throw new CompileError(
                    "error: 'void' must be the only parameter",
                    c
                );
            }

            if (!d) {
                // unnamed prototype parameter, e.g. fn(int, int)
                // but function definition requires named parameters
                throw new CompileError("unnamed parameter", c);
            }

            params.push({
                name: declaratorName(d),
                type: applyDeclaratorType(t, d),
            });
        }

        return { params, variadic };
    }

    /**
     * Compiles a block of code e.g. `{ ... }`, function bodies into instructions and pushes the instructions on to the instruction list
     * @param block A `compound_statement` node
     */
    private compileBlockItems(block: SyntaxNode): void {
        for (const item of block.namedChildren) {
            if (item.type === "comment") continue;
            this.compileStatement(item);
        }
    }

    /**
     * Compiles a single statement e.g. declarations, initialization, expressions, control flow
     */
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
            case "compound_statement": {
                this.emit({ op: "ENTER_SCOPE" }, node);
                this.scopeDepth++;
                this.scopeMarks.push(this.frameCursor);
                this.compileBlockItems(node);
                this.frameCursor = this.scopeMarks.pop()!; // siblings reuse these slots
                this.emit({ op: "EXIT_SCOPE" }, node);
                this.scopeDepth--;
                return;
            }
            default:
                throw new CompileError(
                    `unsupported statement '${node.type}'`,
                    node
                );
        }
    }

    /**
     * @param node A `declaration` node
     * @returns The storage duration of a declaration (defaults to `automatic` if `static` or `extern` are not stated)
     */
    private declarationStorage(node: SyntaxNode): "static" | "automatic" {
        for (const c of node.children)
            if (
                c.type === "storage_class_specifier" &&
                /static|extern/.test(c.text)
            )
                return "static";
        return "automatic";
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
        this.scopeMarks.push(this.frameCursor);
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
        this.frameCursor = this.scopeMarks.pop()!;
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
            case "identifier": {
                const en = this.ctx.enumerators.get(node.text);
                if (en)
                    return void this.emit(
                        { op: "PUSH_CONST", value: en.value, type: en.type },
                        node
                    );
                this.emit({ op: "LOAD_ADDR", name: node.text }, node);
                return void this.emit({ op: "LOAD" }, node);
            }
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
            case "identifier": {
                if (this.ctx.enumerators.has(node.text))
                    throw new CompileError(
                        `enum constant '${node.text}' is not an lvalue`,
                        node
                    );
                return void this.emit(
                    { op: "LOAD_ADDR", name: node.text },
                    node
                );
            }
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

// ------------------------------------------------
//                  Helpers
// ------------------------------------------------
/*
function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
    if (node.type === "function_declarator") return node;
    const inner = node.childForFieldName("declarator");
    return inner ? findFunctionDeclarator(inner) : null;
}
*/

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

function registerTypedef(node: SyntaxNode, ctx: ModuleCtx): void {
    // `typedef <type> <declarators> ;` — the type may itself define a tag inline.
    const base = baseType(node.childForFieldName("type")!, ctx);
    for (const d of node.childrenForFieldName("declarator")) {
        ctx.typedefs.set(declaratorName(d), applyDeclaratorType(base, d));
    }
}

function resolveAggregate(spec: SyntaxNode, ctx: ModuleCtx): CType {
    const kind: "struct" | "union" =
        spec.type === "union_specifier" ? "union" : "struct";
    const tag = spec.childForFieldName("name")?.text ?? null;
    const body = spec.childForFieldName("body"); // field_declaration_list | null

    if (tag) {
        let canon = ctx.tags.get(tag);
        if (!canon) {
            // Intern BEFORE completing so recursive members (struct Node *next)
            // resolve to this same object.
            const c: CType = {
                kind,
                tag,
                members: null,
                size: null,
                align: null,
            };
            canon = c;
            ctx.tags.set(tag, canon);
        } else if (canon.kind !== kind) {
            throw new CompileError(
                `'${tag}' defined as wrong kind of tag`,
                spec
            );
        }
        const agg = canon as AggregateType;
        if (body) {
            if (agg.members !== null)
                throw new CompileError(
                    `redefinition of '${kind} ${tag}'`,
                    spec
                );
            completeAggregate(agg, body, ctx);
        }
        return agg; // may still be incomplete (forward reference)
    }

    // anonymous: cannot be forward-referenced, so build fully inline.
    if (!body) throw new CompileError(`anonymous ${kind} without a body`, spec);
    const agg: AggregateType = {
        kind,
        tag: null,
        members: null,
        size: null,
        align: null,
    };
    completeAggregate(agg, body, ctx);
    return agg;
}

function completeAggregate(
    t: AggregateType,
    body: SyntaxNode,
    ctx: ModuleCtx
): void {
    // Resolve member types first (this is where recursion through `t` happens).
    const raw: { name: string; type: CType }[] = [];
    for (const fd of body.namedChildren) {
        if (fd.type !== "field_declaration") continue;
        if (fd.namedChildren.some((c) => c.type === "bitfield_clause"))
            throw new CompileError("bitfields not yet supported", fd);
        const base = baseType(fd.childForFieldName("type")!, ctx);
        const decls = fd.childrenForFieldName("declarator");
        if (decls.length === 0)
            throw new CompileError(
                "anonymous struct/union members not yet supported",
                fd
            );
        for (const d of decls)
            raw.push({
                name: declaratorName(d),
                type: applyDeclaratorType(base, d),
            });
    }

    const members: Member[] = [];
    let maxAlign = 1;
    if (t.kind === "union") {
        let size = 0;
        for (const m of raw) {
            const a = alignOf(m.type);
            maxAlign = Math.max(maxAlign, a);
            size = Math.max(size, sizeOf(m.type));
            members.push({ ...m, offset: 0 });
        }
        t.size = roundUp(size, maxAlign);
    } else {
        let offset = 0;
        for (const m of raw) {
            const a = alignOf(m.type);
            offset = roundUp(offset, a);
            members.push({ ...m, offset });
            offset += sizeOf(m.type);
            maxAlign = Math.max(maxAlign, a);
        }
        t.size = roundUp(offset, maxAlign);
    }
    t.members = members;
    t.align = maxAlign;
}

function resolveEnum(spec: SyntaxNode, ctx: ModuleCtx): CType {
    const tag = spec.childForFieldName("name")?.text ?? null;
    const body = spec.childForFieldName("body"); // enumerator_list | null
    const enumType: CType = {
        kind: "enum",
        tag,
        underlying: { kind: "int", bits: 32, signed: true },
    };

    if (tag) {
        const existing = ctx.tags.get(tag);
        if (existing) {
            if (existing.kind !== "enum")
                throw new CompileError(
                    `'${tag}' defined as wrong kind of tag`,
                    spec
                );
            if (!body) return existing;
            throw new CompileError(`redefinition of 'enum ${tag}'`, spec);
        }
        ctx.tags.set(tag, enumType);
    }

    if (body) {
        let counter = 0;
        for (const e of body.namedChildren) {
            if (e.type !== "enumerator") continue;
            const valNode = e.childForFieldName("value");
            if (valNode) counter = evalConstInt(valNode);
            ctx.enumerators.set(e.childForFieldName("name")!.text, {
                value: counter,
                type: enumType,
            });
            counter++;
        }
    }
    return enumType;
}

// Minimal constant evaluator: integer/char literals + unary +/-/~ only.
// General constant folding is deferred per scope.
function evalConstInt(node: SyntaxNode): number {
    switch (node.type) {
        case "number_literal":
            return parseNumber(node.text).value;
        case "char_literal":
            return charValue(node);
        case "parenthesized_expression": {
            const inner = node.namedChildren.find((n) => n.type !== "comment");
            if (!inner) throw new CompileError("empty parentheses", node);
            return evalConstInt(inner);
        }
        case "unary_expression": {
            const op = node.childForFieldName("operator")!.text;
            const v = evalConstInt(node.childForFieldName("argument")!);
            if (op === "-") return -v;
            if (op === "+") return v;
            if (op === "~") return ~v;
            throw new CompileError(
                `unsupported constant operator '${op}'`,
                node
            );
        }
        default:
            throw new CompileError(
                "only integer/char literal constants are supported here",
                node
            );
    }
}

/**
 *
 * @param spec A `SyntaxNode`
 * @param ctx Context to use to search for non-primitive user-defined types (structs, enums) to detect naming conflicts or redeclarations
 * @returns The base type (`CType`) of a node
 */
function baseType(spec: SyntaxNode, ctx: ModuleCtx): CType {
    switch (spec.type) {
        case "primitive_type":
            return primitiveToCType(spec.text, spec);
        case "sized_type_specifier":
            return sizedToCType(spec);
        case "type_identifier": {
            const t = ctx.typedefs.get(spec.text);
            if (!t)
                throw new CompileError(
                    `unknown type name '${spec.text}'`,
                    spec
                );
            return t;
        }
        // TODO:
        case "struct_specifier":
        case "union_specifier":
            return resolveAggregate(spec, ctx);
        case "enum_specifier":
            return resolveEnum(spec, ctx);
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
    const m = /^u?int(\d+)_t$/.exec(text);
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

export function sizeOf(t: CType): number {
    switch (t.kind) {
        case "bool":
            return 1;
        case "int":
        case "float":
            return t.bits / 8;
        case "enum":
            return t.underlying.bits / 8; // 4
        case "pointer":
            return 8;
        case "array":
            if (t.length === null)
                throw new Error("sizeOf: incomplete array (no length)");
            return t.length * sizeOf(t.of);
        case "struct":
        case "union":
            if (t.size === null)
                throw new Error(
                    `sizeOf: incomplete ${t.kind} '${t.tag ?? "<anonymous>"}'`
                );
            return t.size;
        case "void":
            throw new Error("sizeOf(void)");
        case "function":
            throw new Error("sizeOf(function)");
    }
}

export function alignOf(t: CType): number {
    switch (t.kind) {
        case "bool":
            return 1;
        case "int":
        case "float":
            return t.bits / 8;
        case "enum":
            return t.underlying.bits / 8;
        case "pointer":
            return 8;
        case "array":
            return alignOf(t.of);
        case "struct":
        case "union":
            if (t.align === null)
                throw new Error(
                    `alignOf: incomplete ${t.kind} '${t.tag ?? "<anonymous>"}'`
                );
            return t.align;
        case "void":
        case "function":
            throw new Error(`alignOf(${t.kind})`);
    }
}

export function convert(value: number | bigint, to: CType): number | bigint {
    switch (to.kind) {
        case "bool":
            return toBool(value) ? 1 : 0;
        case "int":
            return wrapInt(value, to.bits, to.signed);
        case "enum":
            return wrapInt(value, 32, true);
        case "pointer":
            return wrapInt(value, 64, false); // stored/compared as u64
        case "float": {
            const n = typeof value === "bigint" ? Number(value) : value;
            return to.bits === 32 ? Math.fround(n) : n;
        }
        case "void":
            return 0; // (void)x discards
        default:
            throw new Error(`cannot convert to ${to.kind}`);
    }
}

export interface RtValue {
    value: number | bigint;
    type: CType;
}

const COMPARE = new Set(["==", "!=", "<", ">", "<=", ">="]);

export function binaryOp(op: string, lhs: RtValue, rhs: RtValue): RtValue {
    const lp = lhs.type.kind === "pointer" || lhs.type.kind === "array";
    const rp = rhs.type.kind === "pointer" || rhs.type.kind === "array";
    if (lp || rp) return pointerBinary(op, lhs, rhs, lp, rp);

    if (lhs.type.kind === "float" || rhs.type.kind === "float") {
        const a = Number(lhs.value),
            b = Number(rhs.value);
        if (COMPARE.has(op))
            return { value: compareOp(op, a, b) ? 1 : 0, type: INT };
        const dbl =
            (lhs.type.kind === "float" && lhs.type.bits === 64) ||
            (rhs.type.kind === "float" && rhs.type.bits === 64);
        const r = floatArith(op, a, b);
        return {
            value: dbl ? r : Math.fround(r),
            type: { kind: "float", bits: dbl ? 64 : 32 },
        };
    }

    // shifts: result has the promoted left type; amount is the right operand
    if (op === "<<" || op === ">>") {
        const lt = promoteIntType(lhs.type);
        const la = toBig(convert(lhs.value, lt));
        const sa = toBig(rhs.value);
        return {
            value: wrapToType(op === "<<" ? la << sa : la >> sa, lt),
            type: lt,
        };
    }

    const common = arithCommon(lhs.type, rhs.type);
    const a = toBig(convert(lhs.value, common));
    const b = toBig(convert(rhs.value, common));
    if (COMPARE.has(op))
        return { value: compareOp(op, a, b) ? 1 : 0, type: INT };
    return { value: wrapToType(intArith(op, a, b), common), type: common };
}

export function unaryOp(op: string, x: RtValue): RtValue {
    if (op === "!") {
        const t =
            x.type.kind === "float"
                ? Number(x.value) !== 0
                : toBig(x.value) !== 0n;
        return { value: t ? 0 : 1, type: INT };
    }
    if (x.type.kind === "float") {
        return {
            value: op === "-" ? -Number(x.value) : Number(x.value),
            type: x.type,
        };
    }
    const t = promoteIntType(x.type);
    const v = toBig(x.value);
    const r = op === "-" ? -v : op === "~" ? ~v : v;
    return { value: wrapToType(r, t), type: t };
}

function pointerBinary(
    op: string,
    lhs: RtValue,
    rhs: RtValue,
    lp: boolean,
    rp: boolean
): RtValue {
    if (COMPARE.has(op))
        return {
            value: compareOp(op, Number(lhs.value), Number(rhs.value)) ? 1 : 0,
            type: INT,
        };
    if (lp && rp) {
        if (op !== "-") throw new Error(`invalid pointer operator '${op}'`);
        const size = sizeOf(ptrPointee(lhs.type));
        const diff = Math.trunc((Number(lhs.value) - Number(rhs.value)) / size);
        return {
            value: BigInt(diff),
            type: { kind: "int", bits: 64, signed: true },
        };
    }
    const ptr = lp ? lhs : rhs;
    const i = Number(lp ? rhs.value : lhs.value);
    const elem = ptrPointee(ptr.type);
    let addr: number;
    if (op === "+") addr = Number(ptr.value) + i * sizeOf(elem);
    else if (op === "-" && lp) addr = Number(ptr.value) - i * sizeOf(elem);
    else throw new Error(`invalid pointer operator '${op}'`);
    return { value: addr, type: { kind: "pointer", to: elem } };
}

function ptrPointee(t: CType): CType {
    if (t.kind === "pointer") return t.to;
    if (t.kind === "array") return t.of;
    throw new Error("not a pointer");
}
function toBig(v: number | bigint): bigint {
    return typeof v === "bigint" ? v : BigInt(Math.trunc(v));
}
function wrapToType(v: bigint, t: CType): number | bigint {
    return convert(v, t);
}
function intArith(op: string, a: bigint, b: bigint): bigint {
    switch (op) {
        case "+":
            return a + b;
        case "-":
            return a - b;
        case "*":
            return a * b;
        case "/":
            if (b === 0n) throw new Error("division by zero");
            return a / b;
        case "%":
            if (b === 0n) throw new Error("modulo by zero");
            return a % b;
        case "&":
            return a & b;
        case "|":
            return a | b;
        case "^":
            return a ^ b;
        default:
            throw new Error(`unsupported operator '${op}'`);
    }
}
function floatArith(op: string, a: number, b: number): number {
    switch (op) {
        case "+":
            return a + b;
        case "-":
            return a - b;
        case "*":
            return a * b;
        case "/":
            return a / b; // /0 -> Infinity, not a fault
        default:
            throw new Error(`unsupported float operator '${op}'`);
    }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compareOp(op: string, a: any, b: any): boolean {
    switch (op) {
        case "==":
            return a === b;
        case "!=":
            return a !== b;
        case "<":
            return a < b;
        case ">":
            return a > b;
        case "<=":
            return a <= b;
        case ">=":
            return a >= b;
        default:
            throw new Error(`unsupported comparison '${op}'`);
    }
}
function promoteIntType(t: CType): CType {
    if (t.kind === "int") return t.bits < 32 ? INT : t;
    if (t.kind === "bool" || t.kind === "enum") return INT;
    throw new Error(`cannot promote ${t.kind}`);
}
function arithCommon(a: CType, b: CType): CType {
    const pa = promoteIntType(a) as Extract<CType, { kind: "int" }>;
    const pb = promoteIntType(b) as Extract<CType, { kind: "int" }>;
    const bits = Math.max(pa.bits, pb.bits) as 32 | 64;
    let signed: boolean;
    if (pa.signed === pb.signed) signed = pa.signed;
    else {
        const uBits = pa.signed ? pb.bits : pa.bits;
        const sBits = pa.signed ? pa.bits : pb.bits;
        signed = uBits >= sBits ? false : true;
    }
    return { kind: "int", bits, signed };
}

function toBool(v: number | bigint): boolean {
    return typeof v === "bigint" ? v !== 0n : v !== 0 && !Number.isNaN(v);
}

// asIntN/asUintN wrap for any width; bigint for 64-bit, number otherwise (matches the memory layer).
function wrapInt(
    value: number | bigint,
    bits: 8 | 16 | 32 | 64,
    signed: boolean
): number | bigint {
    let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    v = signed ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v);
    return bits === 64 ? v : Number(v);
}

// usage:
//   const funcs  = compileProgram(tree.rootNode);
//   const byName = new Map(funcs.map(f => [f.name, f]));
//   // runtime runs "@init" (globals) first, then CALLs main.
export function compileProgram(root: SyntaxNode): IRFunction[] {
    const ctx: ModuleCtx = {
        typedefs: new Map(),
        tags: new Map(),
        enumerators: new Map(),
    };
    const functions: IRFunction[] = [];
    const init = FunctionCompiler.synthetic("@init", ctx, root);

    for (const item of root.namedChildren)
        compileTopLevelItem(item, ctx, functions, init);

    if (init.hasInstructions()) functions.unshift(init.finish());
    return functions;
}

function compileTopLevelItem(
    item: SyntaxNode,
    ctx: ModuleCtx,
    functions: IRFunction[],
    init: FunctionCompiler
): void {
    switch (item.type) {
        case "function_definition":
            functions.push(new FunctionCompiler(item, ctx).compile());
            return;
        case "declaration":
            init.compileGlobalDeclaration(item);
            return;
        case "type_definition":
            registerTypedef(item, ctx);
            return;
        case "struct_specifier":
        case "union_specifier":
            resolveAggregate(item, ctx);
            return;
        case "enum_specifier":
            resolveEnum(item, ctx);
            return;
        case "linkage_specification": {
            const body = item.childForFieldName("body");
            if (body?.type === "declaration_list")
                for (const inner of body.namedChildren)
                    compileTopLevelItem(inner, ctx, functions, init);
            else if (body) compileTopLevelItem(body, ctx, functions, init);
            return;
        }
        case "comment":
            return;
        default:
            if (item.type.startsWith("preproc_")) return;
            throw new CompileError(
                "only variable declarations and function/struct/union/enum " +
                    "declarations are allowed at file scope",
                item
            );
    }
}
