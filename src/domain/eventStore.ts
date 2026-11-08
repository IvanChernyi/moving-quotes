// The store's contracts. Pure types: the domain names them, storage implements them.

import { Result, Stored } from './result';

// What append answers when the stream moved on since it was read.
// The caller may re-read, decide again, and retry.
export const CONFLICT = 'the stream changed since it was read';

// Write side: one stream per aggregate.
export interface EventStore<E> {
    read(stream: string): Stored<E>[];
    // Appends only if the stream's last seq is still expectedSeq (0 for a new stream).
    // This is what keeps an invariant true when two people act at the same moment.
    append(stream: string, expectedSeq: number, events: E[]): Result<void>;
}

// Read side: every stream, in the order things happened. For projections only.
export interface EventFeed<E> {
    readAll(): Stored<E>[];
}
