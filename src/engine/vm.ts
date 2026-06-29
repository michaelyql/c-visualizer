// Control flow (CALL/RET/jumps/scopes) + memory/arithmetic (ALLOC/LOAD_ADDR/
// LOAD/STORE/INDEX/BINARY/UNARY). FIELD is pending the {name} Op change.

import type {
    CType,
    IRFunction,
    Instr,
    MemObject,
    RtValue,
    Status,
} from "./compiler";
import { alignOf, binaryOp, convert, sizeOf, unaryOp } from "./compiler";
import { Memory, VADDR, type ScalarKind } from "./memory";

const INT32: CType = { kind: "int", bits: 32, signed: true };
const align = (n: number, a: number) => Math.ceil(n / a) * a;

interface Scope {
    bindings: Map<string, number>; // name -> address (local variables)
    statics: Map<string, number>; // local static variables
}
/**
 * An activation frame i.e. "stack frame"
 */
interface Activation {
    fn: IRFunction;
    pc: number;
    scopes: Scope[]; // innermost last; scopes[0] holds params + top-level locals
    frameBase: number; // HIGHEST address of the stack frame (i.e. start of stack frame)
}

/**
 * Abstraction of a virtual machine, to execute instructions
 * based on the custom instruction set
 *
 * An instance is created by supplying it with a list of `IRFunction` to run, and calling `.run()` on the instance
 *
 */
export class VM {
    mem = new Memory();
    callStack: Activation[] = [];
    valueStack: RtValue[] = [];
    objects = new Map<number, MemObject>();
    globals: Scope = { bindings: new Map(), statics: new Map() };

    staticNext = VADDR.STATIC_BASE as number;
    heapNext = VADDR.HEAP_BASE;
    stackNext = VADDR.STACK_TOP + 1;

    stdout = "";
    status: Status = { kind: "running" };

    // Map from function name to IRFunction
    // C does not support function overloading
    private byName: Map<string, IRFunction>;
    private traceEnabled = false;

    constructor(functions: IRFunction[]) {
        this.byName = new Map(functions.map((f) => [f.name, f]));
    }

    run(trace = false): Status {
        this.traceEnabled = trace;
        this.status = { kind: "running" } as Status;

        const init = this.byName.get("@init");
        if (init) {
            this.enter(init);
            this.drive();
            if (this.status.kind === "fault") return this.status;
            this.status = { kind: "running" };
        }
        const main = this.byName.get("main");
        if (!main) {
            this.status = { kind: "fault", reason: "no 'main' function" };
            return this.status;
        }
        this.enter(main);
        this.drive();
        return this.status;
    }

    private drive(): void {
        while (this.status.kind === "running" && this.callStack.length > 0) {
            const f = this.callStack[this.callStack.length - 1];
            const pc = f.pc;
            const instr = f.fn.instructions[f.pc++];

            if (this.traceEnabled)
                console.log(
                    `fn=${f.fn.name},pc=${pc},bp=0x${f.frameBase.toString(16)}  ${describeInstr(instr)}`
                );

            this.exec(instr);

            if (this.traceEnabled)
                console.log(
                    `    stack [${this.valueStack.map(fmtVal).join(", ")}]  depth ${this.callStack.length}`
                );
        }
        if (this.status.kind === "fault") {
            console.log(
                `error: ${this.status.reason}, addr=${this.status.addr}`
            );
        }
    }

    private top(): Activation {
        return this.callStack[this.callStack.length - 1];
    }
    private currentScope(): Scope {
        const s = this.top().scopes;
        return s[s.length - 1];
    }
    private resolveName(name: string): number | undefined {
        const scopes = this.top().scopes;
        for (let i = scopes.length - 1; i >= 0; i--) {
            const a = scopes[i].bindings.get(name);
            if (a !== undefined) return a;
        }
        return this.globals.bindings.get(name);
    }

    /**
     * Updates the `status` of the VM and stops execution
     * @param reason
     * @param addr
     */
    private fault(reason: string, addr?: number): void {
        this.status = { kind: "fault", reason, addr };
    }

    /**
     * Pushes an `Activation` frame onto the call stack
     * @param fn The `IRFunction` to enter
     * @returns The `Activation` frame representing the function
     */
    private enter(fn: IRFunction): Activation {
        // x86-64 ABI mandates that stack frames are 16-byte aligned, i.e.
        // i.e. stack frame base addresses are 0x10, 0x20, ... (always ending in 0)
        const newSP = (this.stackNext - fn.frameSize) & -15;

        // check for overflow
        if (newSP < this.heapNext) {
            this.fault("stack overflow", this.stackNext);
        }

        const frameBase = this.stackNext;
        this.stackNext = newSP;

        const act: Activation = {
            fn,
            pc: 0,
            scopes: [{ bindings: new Map(), statics: new Map() }],
            frameBase,
        };
        this.callStack.push(act);
        return act;
    }

    private storeScalar(
        addr: number,
        type: CType,
        value: number | bigint
    ): void {
        const f = this.mem.writeScalar(addr, scalarKind(type), value);
        if (f)
            this.fault(`bad write at 0x${addr.toString(16)} (${f.kind})`, addr);
    }

    /**
     * Executes a single instruction from the instruction set.
     * @param instr
     * @returns
     */
    private exec(instr: Instr): void {
        switch (instr.op) {
            case "PUSH_CONST": {
                if (typeof instr.value === "string")
                    return this.fault("string literals need string lowering");
                this.valueStack.push({ value: instr.value, type: instr.type });
                return;
            }
            case "POP":
                this.valueStack.pop();
                return;
            case "ENTER_SCOPE":
                this.top().scopes.push({
                    bindings: new Map(),
                    statics: new Map(),
                });
                return;
            case "EXIT_SCOPE":
                this.top().scopes.pop();
                return;
            case "JUMP":
                this.top().pc = instr.target;
                return;
            case "JUMP_IF_FALSE": {
                if (!truthy(this.valueStack.pop()!.value))
                    this.top().pc = instr.target;
                return;
            }
            case "JUMP_IF_TRUE": {
                if (truthy(this.valueStack.pop()!.value))
                    this.top().pc = instr.target;
                return;
            }

            case "ALLOC": {
                const size = sizeOf(instr.ctype);
                if (instr.storage === "static") {
                    // TODO:
                    // if static variable is declined inside a function, should have name mangling i.e. prepend function name before variable name to distinguish them
                    // when resolving local variables, if it refers to a static local variable, the static local variable should be hoisted to the function scope level

                    // file level static -> global binding
                    // function level static -> bind to function scope

                    // static memory grows up
                    this.staticNext = align(
                        this.staticNext,
                        alignOf(instr.ctype)
                    ); // round up to multiple of ctype's size
                    const addr = this.staticNext;
                    this.staticNext += size;
                    this.mem.writeBytes(addr, new Uint8Array(size)); // zero-init + mark initialized
                    this.globals.bindings.set(instr.name, addr);
                    this.objects.set(addr, {
                        address: addr,
                        type: instr.ctype,
                        name: instr.name,
                        region: "static",
                        size,
                        lifecycle: "alive",
                    });
                } else {
                    // stack grows down
                    const addr_ =
                        this.top().frameBase -
                        instr.offset -
                        sizeOf(instr.ctype); // bytes stay uninitialized

                    // check for redeclaration in the same scope (illegal)
                    const scope_ = this.currentScope();
                    if (
                        scope_.bindings.has(instr.name) ||
                        scope_.statics.has(instr.name)
                    ) {
                        this.fault(
                            `redeclaration of variable ${instr.name}`,
                            addr_
                        );
                        return;
                    }

                    scope_.bindings.set(instr.name, addr_);
                    this.objects.set(addr_, {
                        address: addr_,
                        type: instr.ctype,
                        name: instr.name,
                        region: "stack",
                        size,
                        lifecycle: "alive",
                    });
                }
                return;
            }

            case "LOAD_ADDR": {
                const addr = this.resolveName(instr.name);
                if (addr === undefined)
                    return this.fault(`unknown variable '${instr.name}'`);
                const obj = this.objects.get(addr)!;
                this.valueStack.push({
                    value: addr,
                    type: { kind: "pointer", to: obj.type },
                });
                return;
            }

            case "LOAD": {
                const ptr = this.valueStack.pop()!;
                if (ptr.type.kind !== "pointer")
                    return this.fault("LOAD of a non-pointer");
                const pointee = ptr.type.to;
                const addr = Number(ptr.value);
                if (pointee.kind === "array") {
                    // array-to-pointer decay: yield &elem[0], do not read bytes
                    this.valueStack.push({
                        value: addr,
                        type: { kind: "pointer", to: pointee.of },
                    });
                    return;
                }
                if (pointee.kind === "struct" || pointee.kind === "union")
                    return this.fault(
                        "loading a whole struct/union by value not yet supported"
                    );
                if (pointee.kind === "void" || pointee.kind === "function")
                    return this.fault(`cannot LOAD a ${pointee.kind}`);
                const loc = this.mem.resolve(addr);
                if ("kind" in loc)
                    return this.fault(`invalid read (${loc.kind})`, addr);
                if (!this.mem.isInitialized(addr, sizeOf(pointee)))
                    return this.fault("use of uninitialized value", addr);
                const v = this.mem.readScalar(addr, scalarKind(pointee)) as
                    | number
                    | bigint;
                this.valueStack.push({ value: v, type: pointee });
                return;
            }

            case "STORE": {
                const val = this.valueStack.pop()!;
                const dest = this.valueStack.pop()!;
                if (dest.type.kind !== "pointer")
                    return this.fault("STORE to a non-pointer");
                const pointee = dest.type.to;
                if (
                    pointee.kind === "array" ||
                    pointee.kind === "struct" ||
                    pointee.kind === "union" ||
                    pointee.kind === "void" ||
                    pointee.kind === "function"
                )
                    return this.fault(`cannot STORE to a ${pointee.kind}`);
                const addr = Number(dest.value);
                const loc = this.mem.resolve(addr);
                if ("kind" in loc)
                    return this.fault(`invalid write (${loc.kind})`, addr);
                const out = convert(val.value, pointee);
                this.storeScalar(addr, pointee, out);
                this.valueStack.push({ value: out, type: pointee }); // assignment is an expression
                return;
            }

            case "INDEX": {
                const idx = this.valueStack.pop()!;
                const base = this.valueStack.pop()!;
                if (base.type.kind !== "pointer")
                    return this.fault("indexing a non-pointer");
                const elem = base.type.to;
                const addr =
                    Number(base.value) + Number(idx.value) * sizeOf(elem);
                this.valueStack.push({
                    value: addr,
                    type: { kind: "pointer", to: elem },
                });
                return;
            }

            case "BINARY": {
                const rhs = this.valueStack.pop()!;
                const lhs = this.valueStack.pop()!;
                try {
                    this.valueStack.push(binaryOp(instr.operator, lhs, rhs));
                } catch (e) {
                    this.fault((e as Error).message);
                }
                return;
            }

            case "UNARY": {
                const x = this.valueStack.pop()!;
                try {
                    this.valueStack.push(unaryOp(instr.operator, x));
                } catch (e) {
                    this.fault((e as Error).message);
                }
                return;
            }

            case "CALL": {
                const callee = this.byName.get(instr.fn);
                if (!callee) {
                    // builtins (printf/malloc/free) plug in here with the memory fork done;
                    // printf reads its format string from memory.
                    return this.fault(`undefined function '${instr.fn}'`);
                }
                const args: RtValue[] = [];
                for (let i = 0; i < instr.argc; i++)
                    args.unshift(this.valueStack.pop()!);

                const act = this.enter(callee);
                if (this.status.kind !== "running") return;

                // should this be failing silently if the lengths don't match?
                const n = Math.min(callee.params.length, args.length);

                for (let i = 0; i < n; i++) {
                    const p = callee.params[i];

                    const addr = act.frameBase - p.offset - sizeOf(p.type);
                    this.storeScalar(
                        addr,
                        p.type,
                        convert(args[i].value, p.type)
                    );
                    if (this.status.kind !== "running") return;

                    // bind variable names in the initial block scope
                    act.scopes[0].bindings.set(p.name, addr);
                    this.objects.set(addr, {
                        address: addr,
                        type: p.type,
                        name: p.name,
                        region: "stack",
                        size: sizeOf(p.type),
                        lifecycle: "alive",
                    });
                }
                return;
            }

            case "RET": {
                let ret: RtValue | null = null;
                if (instr.hasValue) ret = this.valueStack.pop() ?? null;
                const act = this.callStack.pop()!;
                this.stackNext = act.frameBase;
                if (this.callStack.length === 0) {
                    const code = ret ? Number(convert(ret.value, INT32)) : 0;
                    this.status = { kind: "halted", exitCode: code };
                } else if (ret) {
                    this.valueStack.push({
                        value: convert(ret.value, act.fn.returnType),
                        type: act.fn.returnType,
                    });
                }
                return;
            }

            case "FIELD":
                this.fault(
                    "FIELD needs the {name} Op change for runtime field resolution"
                );
                return;
        }
    }

    // Manual inspector: print the call stack with each in-scope variable decoded.
    dumpFrames(): void {
        console.log("── call stack (top last) ──");
        for (const act of this.callStack) {
            console.log(
                `  ${act.fn.name}  pc=${act.pc}  frameBase=0x${act.frameBase.toString(16)}`
            );
            for (let i = act.scopes.length - 1; i >= 0; i--)
                for (const [name, addr] of act.scopes[i].bindings)
                    console.log(
                        `    ${name} @0x${addr.toString(16)} = ${this.readForDisplay(addr)}`
                    );
        }
    }

    private readForDisplay(addr: number): string {
        const obj = this.objects.get(addr);
        if (!obj) return "?";
        const t = obj.type;
        if (t.kind === "struct" || t.kind === "union" || t.kind === "array")
            return `<${typeName(t)}>`;
        if (!this.mem.isInitialized(addr, sizeOf(t))) return "<uninit>";
        const v = this.mem.readScalar(addr, scalarKind(t));
        return typeof v === "object" ? "<fault>" : `${v}`;
    }
} // VM class

// ======================== Helpers =============================
function typeName(t: CType): string {
    switch (t.kind) {
        case "void":
            return "void";
        case "bool":
            return "bool";
        case "int":
            return (
                (t.signed ? "" : "u") +
                (t.bits === 8
                    ? "char"
                    : t.bits === 16
                      ? "short"
                      : t.bits === 32
                        ? "int"
                        : "long")
            );
        case "float":
            return t.bits === 32 ? "float" : "double";
        case "pointer":
            return typeName(t.to) + "*";
        case "array":
            return `${typeName(t.of)}[${t.length ?? ""}]`;
        case "struct":
            return `struct ${t.tag ?? "<anon>"}`;
        case "union":
            return `union ${t.tag ?? "<anon>"}`;
        case "enum":
            return `enum ${t.tag ?? "<anon>"}`;
        case "function":
            return "fn";
    }
}
function fmtVal(v: RtValue): string {
    if (v.type.kind == "pointer") {
        return `0x${(v.value as number).toString(16)}:${typeName(v.type)}`;
    }
    return `${v.value as number}:${typeName(v.type)}`;
}
function describeInstr(i: Instr): string {
    switch (i.op) {
        case "PUSH_CONST":
            return `PUSH_CONST ${i.value} (${typeName(i.type)})`;
        case "LOAD_ADDR":
            return `LOAD_ADDR ${i.name}`;
        case "LOAD":
            return "LOAD";
        case "STORE":
            return "STORE";
        case "BINARY":
            return `BINARY ${i.operator}`;
        case "UNARY":
            return `UNARY ${i.operator}`;
        case "INDEX":
            return "INDEX";
        case "FIELD":
            return `FIELD +${i.offset}`;
        case "ALLOC":
            return `ALLOC ${i.name} (${typeName(i.ctype)}, ${i.storage}@${i.offset})`;
        case "ENTER_SCOPE":
            return "ENTER_SCOPE";
        case "EXIT_SCOPE":
            return "EXIT_SCOPE";
        case "JUMP":
            return `JUMP ${i.target}`;
        case "JUMP_IF_FALSE":
            return `JUMP_IF_FALSE ${i.target}`;
        case "JUMP_IF_TRUE":
            return `JUMP_IF_TRUE ${i.target}`;
        case "CALL":
            return `CALL ${i.fn}/${i.argc}`;
        case "RET":
            return `RET ${i.hasValue ? "value" : "void"}`;
        case "POP":
            return "POP";
    }
}

function truthy(v: number | bigint): boolean {
    return typeof v === "bigint" ? v !== 0n : v !== 0 && !Number.isNaN(v);
}

function scalarKind(t: CType): ScalarKind {
    switch (t.kind) {
        case "bool":
            return "u8";
        case "enum":
            return "i32";
        case "pointer":
            return "u64";
        case "float":
            return t.bits === 32 ? "f32" : "f64";
        case "int":
            return `${t.signed ? "i" : "u"}${t.bits}` as ScalarKind;
        default:
            throw new Error(`no scalar kind for ${t.kind}`);
    }
}
