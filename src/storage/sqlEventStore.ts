// storage, impure: one table per event type, one stream per aggregate, seq per stream.
// Implements the write-side store and the read-side feed. zod checks every payload on the way back in.

import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CONFLICT, EventFeed, EventStore } from '../domain/eventStore';
import { Result, Stored } from '../domain/result';

interface Row {
    seq: number;
    payload: string;
}

export class SqlEventStore<E extends { type: string }> implements EventStore<E>, EventFeed<E> {
    // the table name is chosen in main.ts, never taken from a request
    constructor(private readonly db: DatabaseSync, private readonly table: string, private readonly schema: z.ZodType<E>) {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${table} (
                position INTEGER PRIMARY KEY AUTOINCREMENT,   -- order across all streams, for projections
                stream   TEXT NOT NULL,
                seq      INTEGER NOT NULL,                    -- order inside one stream
                type     TEXT NOT NULL,
                payload  TEXT NOT NULL,                       -- the event as JSON
                UNIQUE (stream, seq)
            )
        `);
    }

    read(stream: string): Stored<E>[] {
        const rows = this.db.prepare(`SELECT seq, payload FROM ${this.table} WHERE stream = ? ORDER BY seq`).all(stream) as unknown as Row[];
        return rows.map((row) => this.toStored(row));
    }

    append(stream: string, expectedSeq: number, events: E[]): Result<void> {
        let open = false;
        try {
            this.db.exec('BEGIN IMMEDIATE');   // one writer at a time: the check and the insert cannot interleave
            open = true;
            const current = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.table} WHERE stream = ?`).get(stream) as unknown as { seq: number };
            if (current.seq !== expectedSeq) {
                this.db.exec('ROLLBACK');
                open = false;
                return { ok: false, error: CONFLICT };
            }
            const insert = this.db.prepare(`INSERT INTO ${this.table} (stream, seq, type, payload) VALUES (?, ?, ?, ?)`);
            events.forEach((event, i) => insert.run(stream, expectedSeq + i + 1, event.type, JSON.stringify(event)));
            this.db.exec('COMMIT');
            open = false;
            return { ok: true, value: undefined };
        } catch (err) {
            if (open) this.db.exec('ROLLBACK');
            console.error(err);
            return { ok: false, error: 'could not store the events' };
        }
    }

    readAll(): Stored<E>[] {
        const rows = this.db.prepare(`SELECT seq, payload FROM ${this.table} ORDER BY position`).all() as unknown as Row[];
        return rows.map((row) => this.toStored(row));
    }

    private toStored(row: Row): Stored<E> {
        return { ...this.schema.parse(JSON.parse(row.payload)), seq: row.seq };   // a corrupt row throws: a storage bug, not a user error
    }
}
