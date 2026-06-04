type Address = number;

type Instruction = { tag: "eval" };

interface Member {
    name: string;
    type: CType;
}

type CType =
    | { kind: "void" }
    | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean } // char/short/int/long
    | { kind: "float"; bits: 32 | 64 } // float/double
    | { kind: "bool" }
    | { kind: "pointer"; to: CType }
    | { kind: "array"; of: CType; length: number | null } // null = incomplete: int a[]
    | { kind: "function"; returns: CType; params: CType[]; variadic: boolean }
    | { kind: "struct"; tag: string | null; members: Member[] | null } // null = forward-declared
    | { kind: "union"; tag: string | null; members: Member[] | null }
    | {
          kind: "enum";
          tag: string | null;
          underlying: { kind: "int"; bits: 32; signed: true }; // always int for C99
      };

// // const/volatile/restrict don't change execution semantics much; attach an optional
// // `qualifiers?: Set<"const"|"volatile"|"restrict">` later if you want to enforce them.

interface Variable {
    name: string;
    type: CType;
    offset: number; // relative to BP
}

interface Environment {
    bindings: Map<string, Variable>;
    parent: Environment | null;
}

interface StackFrame {
    functionName: string;
    basePointer: number;
    environment: Environment;
    // parameters: map<string, >
    // locals: map<string, >
    // size: number;
}

// Snapshot of an execution state
interface State {
    memory: Uint8Array;
    control: Instruction[];
    stack: StackFrame[];
    // store:
}

export interface MemObject {
    address: Address;
    type: CType;
    size: number;
    name?: string; // for the visualizer
    storage: "static" | "automatic" | "dynamic";
    // maybe store the raw bytes here directly, instead of having store keep them?
}
export interface Store {
    bytes: Map<Address, number>; // sparse: addr -> byte
    objects: Map<Address, MemObject>; // metadata for typed access + display
    next: Address; // bump allocator
}

interface ExecutionState {}

export type {
    Address,
    Environment,
    ExecutionState,
    Instruction,
    StackFrame,
    State,
};

// type ExprId = number;
// type BlockId = number;
// type FunctionId = string;

// type IRInstr =
//     | { tag: "const"; value: Value }
//     | { tag: "load"; name: string }
//     | { tag: "store"; name: string }
//     | { tag: "binop"; op: string }
//     | { tag: "unop"; op: string }
//     | { tag: "declare"; name: string; type: CType }
//     | { tag: "jump"; target: number }
//     | { tag: "jump-if-false"; target: number }
//     | { tag: "call"; fn: FunctionId; argc: number }
//     | { tag: "return" }
//     | { tag: "push-scope" }
//     | { tag: "pop-scope" }
//     | { tag: "discard" };

// interface IRFunction {
//     name: string;
//     params: Parameter[];
//     code: IRInstr[];
// }

// export interface IRProgram {
//     globals: IRInstr[];
//     functions: Map<string, IRFunction>;
// }

// /**
//  * state of the CESK engine
//  */
// export interface State {
//     control: ControlFrame[];

//     values: StackEntry[];

//     env: Environment;

//     store: Store;

//     status: "running" | "done";
// }

// export type Mode = "rvalue" | "lvalue";

// export type Instr =
//     | { tag: "eval"; node: Node; mode: Mode }
//     | { tag: "binop"; operator: string }
//     | { tag: "assign"; operator: string }
//     | { tag: "branch"; then: Node; else: Node | null }
//     | { tag: "while"; node: Node }
//     | { tag: "call"; fn: string; argc: number }
//     | { tag: "declare"; name: string; type: CType }
//     | { tag: "pop-scope" }
//     | { tag: "discard" }
//     | { tag: "loop-marker" } // break/continue unwind to here
//     | { tag: "frame-marker" }; // return unwinds to here

// export type Function = {
//     name: string;
//     returnType: string;
//     params: Variable[];
//     body: Node;
// };

// export type Scope = {
//     variables: Map<string, Variable>;
//     kind: "block" | "function" | "loop";
//     id: number;
// };

// export type ExecutionError = {
//     message: string;
//     line: number;
//     column: number;
// };
