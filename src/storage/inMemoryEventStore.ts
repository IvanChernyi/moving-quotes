// storage: a second plug for the same sockets, over an array. Same contract, no database.
// Used by the command tests. Not a mock: a real implementation that forgets on exit.

import { CONFLICT, EventFeed, EventStore } from '../domain/eventStore';
import { Result, Stored } from '../domain/result';

interface Entry<E> {
    stream: string;
    seq: number;
    event: E;
}

export class InMemoryEventStore<E extends { type: string }> implements EventStore<E>, EventFeed<E> {
    private readonly log: Entry<E>[] = [];

    read(stream: string): Stored<E>[] {
        return this.log.filter((entry) => entry.stream === stream).map((entry) => ({ ...entry.event, seq: entry.seq }));
    }

    append(stream: string, expectedSeq: number, events: E[]): Result<void> {
        const current = this.read(stream).length;   // seq counts from 1 with no gaps
        if (current !== expectedSeq) return { ok: false, error: CONFLICT };
        events.forEach((event, i) => this.log.push({ stream, seq: expectedSeq + i + 1, event: { ...event } }));
        return { ok: true, value: undefined };
    }

    readAll(): Stored<E>[] {
        return this.log.map((entry) => ({ ...entry.event, seq: entry.seq }));
    }
}
