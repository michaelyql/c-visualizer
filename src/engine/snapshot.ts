import type { Status } from "./compiler";
import type { MemObject, RegionId } from "./memory";

// Live byte window of one region + its init bits, bounded by the bump pointer
// so the copy cost is proportional to live size, not the region cap.
export interface RegionImage {
    bytes: Uint8Array; // copy of the live range
    initMask: Uint8Array; // copy of init bits over the same range
    next: number; // bump pointer (defines the live range when sliced)
}

export interface ScopeView {
    bindings: Map<string, number>;
} // name -> address
export interface FrameView {
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
