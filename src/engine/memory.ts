import type { CType } from "./compiler";

export const LITTLE_ENDIAN = true; // model an x86/ARM little-endian target

// Virtual address layout (1 GiB space, matches the prior design).
export const VADDR = {
    NULL_GUARD: 0x00000000,
    STATIC_BASE: 0x00400000, // grows up
    HEAP_BASE: 0x10000000, // grows up
    STACK_TOP: 0x3fffffff, // highest valid byte; stack grows downward
} as const;

// Physical backing caps per region. Tunable; grow-on-demand is a later option.
// (Up-growing regions can grow trivially; the stack would need a base shift, so
// fixed caps + an overflow diagnostic from the allocator is the simple start.)
const CAP = {
    static: 1 << 20, // 1 MiB
    heap: 16 << 20, // 16 MiB
    stack: 1 << 20, // 1 MiB
} as const;

export type ScalarKind =
    | "i8"
    | "u8"
    | "i16"
    | "u16"
    | "i32"
    | "u32"
    | "i64"
    | "u64"
    | "f32"
    | "f64";

const SIZE: Record<ScalarKind, number> = {
    i8: 1,
    u8: 1,
    i16: 2,
    u16: 2,
    i32: 4,
    u32: 4,
    i64: 8,
    u64: 8,
    f32: 4,
    f64: 8,
};

export type RegionId = "static" | "heap" | "stack";

export type Located = { region: RegionId; offset: number };

export type MemFault =
    | { kind: "null" } // address sits in the NULL guard
    | { kind: "unmapped" }; // not inside any backed region (gap, or past a cap)

interface Region {
    id: RegionId;
    base: number; // lowest virtual address this buffer backs
    limit: number; // one past the highest backed virtual address
    growsDown: boolean;
    dv: DataView;
    bytes: Uint8Array;
    initMask: Uint8Array; // 1 bit per backed byte; 1 = written at least once
}

export interface MemObject {
    address: number;
    type: CType;
    name?: string; // named variable; absent for heap/anonymous
    region: RegionId;
    size: number;
    lifecycle: "alive" | "freed"; // freed kept (addresses never reused) for UAF
}

export function makeRegion(
    id: RegionId,
    base: number,
    cap: number,
    growsDown: boolean
): Region {
    const buf = new ArrayBuffer(cap);
    return {
        id,
        base,
        limit: base + cap,
        growsDown,
        dv: new DataView(buf),
        bytes: new Uint8Array(buf),
        initMask: new Uint8Array((cap + 7) >> 3),
    };
}

/**
 * Represents stack / heap / .data, .bss, .rodata segments
 *
 * Each region/segment of memory is backed by a Uint8Array
 *
 * Index i of the Uint8array represent the byte at address i
 *
 * Stack grows downwards, heap and static segment grow up
 */
export class Memory {
    private regions: Region[];

    constructor() {
        this.regions = [
            makeRegion("static", VADDR.STATIC_BASE, CAP.static, false),
            makeRegion("heap", VADDR.HEAP_BASE, CAP.heap, false),
            // Stack buffer covers [STACK_TOP+1-cap, STACK_TOP+1) so ascending address
            // maps to ascending offset (byte order preserved within objects).
            makeRegion(
                "stack",
                VADDR.STACK_TOP + 1 - CAP.stack,
                CAP.stack,
                true
            ),
        ];
    }

    // Finds which region a memory address is located in
    private locate(addr: number): { r: Region; offset: number } | MemFault {
        if (addr <= VADDR.NULL_GUARD) return { kind: "null" };
        for (const r of this.regions) {
            if (addr >= r.base && addr < r.limit)
                return { r, offset: addr - r.base };
        }
        return { kind: "unmapped" };
    }

    // Finds the region a memory address is located in and the offset
    resolve(addr: number): Located | MemFault {
        const l = this.locate(addr);
        return "kind" in l ? l : { region: l.r.id, offset: l.offset };
    }

    regionOf(addr: number): RegionId | null {
        const l = this.locate(addr);
        return "kind" in l ? null : l.r.id;
    }

    private static maskTest(
        mask: Uint8Array,
        off: number,
        size: number
    ): boolean {
        for (let i = off; i < off + size; i++) {
            if ((mask[i >> 3] & (1 << (i & 7))) === 0) return false;
        }
        return true;
    }

    private static maskSet(mask: Uint8Array, off: number, size: number): void {
        for (let i = off; i < off + size; i++) mask[i >> 3] |= 1 << (i & 7);
    }

    isInitialized(addr: number, size: number): boolean {
        const l = this.locate(addr);
        if ("kind" in l) return false;
        if (l.offset + size > l.r.bytes.length) return false;
        return Memory.maskTest(l.r.initMask, l.offset, size);
    }

    // --- bulk access (struct/array copies, memcpy, future page snapshots) ---

    readBytes(addr: number, size: number): Uint8Array | MemFault {
        const l = this.locate(addr);
        if ("kind" in l) return l;
        if (l.offset + size > l.r.bytes.length) return { kind: "unmapped" };
        return l.r.bytes.slice(l.offset, l.offset + size); // copy, not a live view
    }

    writeBytes(addr: number, data: Uint8Array): MemFault | null {
        const l = this.locate(addr);
        if ("kind" in l) return l;
        if (l.offset + data.length > l.r.bytes.length)
            return { kind: "unmapped" };
        l.r.bytes.set(data, l.offset);
        Memory.maskSet(l.r.initMask, l.offset, data.length);
        return null;
    }

    // --- typed scalar access ------------------------------------------------
    // Assumes `value` already carries the correct C type/width; storage-width
    // wrap is the only thing applied here (via DataView's own coercion).

    readScalar(addr: number, kind: ScalarKind): number | bigint | MemFault {
        const l = this.locate(addr);
        if ("kind" in l) return l;
        const size = SIZE[kind];
        if (l.offset + size > l.r.bytes.length) return { kind: "unmapped" };
        const dv = l.r.dv,
            o = l.offset,
            e = LITTLE_ENDIAN;
        switch (kind) {
            case "i8":
                return dv.getInt8(o);
            case "u8":
                return dv.getUint8(o);
            case "i16":
                return dv.getInt16(o, e);
            case "u16":
                return dv.getUint16(o, e);
            case "i32":
                return dv.getInt32(o, e);
            case "u32":
                return dv.getUint32(o, e);
            case "i64":
                return dv.getBigInt64(o, e);
            case "u64":
                return dv.getBigUint64(o, e);
            case "f32":
                return dv.getFloat32(o, e);
            case "f64":
                return dv.getFloat64(o, e);
        }
    }

    writeScalar(
        addr: number,
        kind: ScalarKind,
        value: number | bigint
    ): MemFault | null {
        const l = this.locate(addr);
        if ("kind" in l) return l;
        const size = SIZE[kind];
        if (l.offset + size > l.r.bytes.length) return { kind: "unmapped" };
        const dv = l.r.dv,
            o = l.offset,
            e = LITTLE_ENDIAN;
        switch (kind) {
            case "i8":
                dv.setInt8(o, Number(value));
                break;
            case "u8":
                dv.setUint8(o, Number(value));
                break;
            case "i16":
                dv.setInt16(o, Number(value), e);
                break;
            case "u16":
                dv.setUint16(o, Number(value), e);
                break;
            case "i32":
                dv.setInt32(o, Number(value), e);
                break;
            case "u32":
                dv.setUint32(o, Number(value), e);
                break;
            case "i64":
                dv.setBigInt64(o, BigInt(value), e);
                break;
            case "u64":
                dv.setBigUint64(o, BigInt(value), e);
                break;
            case "f32":
                dv.setFloat32(o, Number(value), e);
                break;
            case "f64":
                dv.setFloat64(o, Number(value), e);
                break;
        }
        Memory.maskSet(l.r.initMask, l.offset, size);
        return null;
    }
}
