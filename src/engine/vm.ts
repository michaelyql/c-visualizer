// vm.ts — IR virtual machine, control-flow half.
// Implements the call/return path + jumps/scopes over pre-allocated frames.
// Memory/arithmetic ops (ALLOC, LOAD_ADDR, LOAD, STORE, BINARY, UNARY, INDEX,
// FIELD) are the next fork and currently throw.

import type { CType, IRFunction, Instr, MemObject, Status } from "./compiler";
import { convert, sizeOf } from "./compiler";
import { Memory, VADDR, type ScalarKind } from "./memory";

const INT32: CType = { kind: "int", bits: 32, signed: true };

interface Scope {
    bindings: Map<string, number>; // name -> address (no stackMark: stackNext moves only on CALL/RET)
}

interface Activation {
    fn: IRFunction;
    pc: number; // index into fn.instructions
    scopes: Scope[]; // innermost last; scopes[0] holds params + top-level locals
    frameBase: number; // lowest address of this frame; var address = frameBase + offset
    savedStackNext: number; // stackNext before this frame, restored on RET
}

type Value = { value: number | bigint; type: CType };

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

export class VM {
    mem = new Memory();
    callStack: Activation[] = [];
    valueStack: Value[] = [];
    objects = new Map<number, MemObject>();

    staticNext = VADDR.STATIC_BASE;
    heapNext = VADDR.HEAP_BASE;
    stackNext = VADDR.STACK_TOP + 1; // exclusive top; first frame sits just below

    stdout = "";
    status: Status = { kind: "running" };

    private byName: Map<string, IRFunction>;

    constructor(functions: IRFunction[]) {
        this.byName = new Map(functions.map((f) => [f.name, f]));
    }

    run(): Status {
        this.status = { kind: "running" } as Status;
        const init = this.byName.get("@init"); // globals, if any
        if (init) {
            this.enter(init);
            this.drive();
            if (this.status.kind === "fault") return this.status;
            this.status = { kind: "running" }; // @init finished; keep going for main
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
            const instr = f.fn.instructions[f.pc++];
            this.exec(instr);
        }
    }

    private top(): Activation {
        return this.callStack[this.callStack.length - 1];
    }

    // Carve a frame and push its activation. stackNext moves only here and in RET.
    private enter(fn: IRFunction): Activation {
        const savedStackNext = this.stackNext;
        const frameBase = (this.stackNext - fn.frameSize) & ~15; // 16-aligned start
        if (fn.frameSize > 0 && "kind" in this.mem.resolve(frameBase)) {
            this.status = {
                kind: "fault",
                reason: "stack overflow",
                addr: frameBase,
            };
        }
        this.stackNext = frameBase;
        const act: Activation = {
            fn,
            pc: 0,
            scopes: [{ bindings: new Map() }],
            frameBase,
            savedStackNext,
        };
        this.callStack.push(act);
        return act;
    }

    private storeScalar(
        addr: number,
        type: CType,
        value: number | bigint
    ): void {
        const fault = this.mem.writeScalar(addr, scalarKind(type), value);
        if (fault)
            this.status = {
                kind: "fault",
                reason: `bad write at 0x${addr.toString(16)} (${fault.kind})`,
                addr,
            };
    }

    private exec(instr: Instr): void {
        switch (instr.op) {
            case "PUSH_CONST": {
                if (typeof instr.value === "string") {
                    // string literals lower to a static array + pointer — memory fork.
                    this.status = {
                        kind: "fault",
                        reason: "string literals need the memory fork",
                    };
                    return;
                }
                this.valueStack.push({ value: instr.value, type: instr.type });
                return;
            }

            case "POP":
                this.valueStack.pop();
                return;

            case "ENTER_SCOPE":
                this.top().scopes.push({ bindings: new Map() });
                return;

            case "EXIT_SCOPE":
                this.top().scopes.pop();
                return;

            case "JUMP":
                this.top().pc = instr.target;
                return;

            case "JUMP_IF_FALSE": {
                const t = this.valueStack.pop()!;
                if (!truthy(t.value)) this.top().pc = instr.target;
                return;
            }

            case "JUMP_IF_TRUE": {
                const t = this.valueStack.pop()!;
                if (truthy(t.value)) this.top().pc = instr.target;
                return;
            }

            case "CALL": {
                const callee = this.byName.get(instr.fn);
                if (!callee) {
                    // builtins (printf, malloc, free) plug in here; printf reads its
                    // format string from memory, so it lands with the memory fork.
                    this.status = {
                        kind: "fault",
                        reason: `undefined function '${instr.fn}'`,
                    };
                    return;
                }
                // pop argc values (caller pushed left->right) back into declaration order
                const args: Value[] = [];
                for (let i = 0; i < instr.argc; i++)
                    args.unshift(this.valueStack.pop()!);

                const act = this.enter(callee);
                if (this.status.kind !== "running") return; // overflow

                const n = Math.min(callee.params.length, args.length);
                for (let i = 0; i < n; i++) {
                    const p = callee.params[i];
                    const addr = act.frameBase + p.offset;
                    this.storeScalar(
                        addr,
                        p.type,
                        convert(args[i].value, p.type)
                    );
                    if (this.status.kind !== "running") return;
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
                // extra variadic args have no home yet; basic programs don't hit this.
                return;
            }

            case "RET": {
                let ret: Value | null = null;
                if (instr.hasValue) ret = this.valueStack.pop() ?? null;
                const act = this.callStack.pop()!;
                this.stackNext = act.savedStackNext; // roll the frame back
                if (this.callStack.length === 0) {
                    const code = ret ? Number(convert(ret.value, INT32)) : 0;
                    this.status = { kind: "halted", exitCode: code };
                } else if (ret) {
                    const v = convert(ret.value, act.fn.returnType);
                    this.valueStack.push({ value: v, type: act.fn.returnType });
                }
                return;
            }

            // ── next fork: memory + arithmetic ──
            case "ALLOC":
            case "LOAD_ADDR":
            case "LOAD":
            case "STORE":
            case "BINARY":
            case "UNARY":
            case "INDEX":
            case "FIELD":
                throw new Error(
                    `op '${instr.op}' not implemented in the control-flow fork`
                );
        }
    }
}
