import type { CType, Member } from "./engine/types";

function sizeof(t: CType): number {
    switch (t.kind) {
        case "void":
            return 1; // GCC extension; standard says error
        case "bool":
            return 1;
        case "int":
            return t.bits / 8;
        case "float":
            return t.bits / 8;
        case "pointer":
            return 8;
        case "array":
            return t.length === null ? 0 : t.length * sizeof(t.of);
        case "enum":
            return sizeof(t.underlying);
        case "function":
            return 0; // functions have no size
        case "struct":
        case "union": {
            if (!t.members) return 0; // incomplete
            if (t.kind === "union")
                return Math.max(...t.members.map((m) => sizeof(m.type)), 0);
            const last = t.members[t.members.length - 1];
            return align(last.offset + sizeof(last.type), alignof(t));
        }
    }
}
function alignof(t: CType): number {
    if (t.kind === "array") return alignof(t.of);
    if (t.kind === "struct" || t.kind === "union")
        return Math.max(...(t.members ?? []).map((m) => alignof(m.type)), 1);
    return sizeof(t) || 1;
}

const align = (off: number, a: number) => Math.ceil(off / a) * a;

// Compute member offsets with padding (only for struct; unions all start at 0).
function layoutStruct(members: { name: string; type: CType }[]): Member[] {
    let off = 0;
    return members.map((m) => {
        off = align(off, alignof(m.type));
        const placed = { name: m.name, type: m.type, offset: off };
        off += sizeof(m.type);
        return placed;
    });
}
