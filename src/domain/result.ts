// Shapes every layer shares. Pure types.

// Failures are values: a verb either produces a value or says why not.
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// What comes out of a store: the event plus its position in its stream.
// seq is the store's row number. No verb ever sets it.
export type Stored<E> = E & { seq: number };
