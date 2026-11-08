// Contract test: one suite, every implementation of the store. The SQL store runs on an in-memory database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CONFLICT, EventFeed, EventStore } from '../src/domain/eventStore';
import { QuoteEvent, QuoteEventSchema } from '../src/domain/quote';
import { InMemoryEventStore } from '../src/storage/inMemoryEventStore';
import { SqlEventStore } from '../src/storage/sqlEventStore';

type Store = EventStore<QuoteEvent> & EventFeed<QuoteEvent>;

const implementations: Array<[string, () => Store]> = [
    ['sql', () => new SqlEventStore<QuoteEvent>(new DatabaseSync(':memory:'), 'quote_events', QuoteEventSchema)],
    ['memory', () => new InMemoryEventStore<QuoteEvent>()],
];

const at = '2026-11-08T12:00:00.000Z';
const started = (quoteId: string): QuoteEvent => ({ type: 'QuoteStarted', quoteId, at });
const trucks = (quoteId: string, count: number): QuoteEvent => ({ type: 'TrucksChosen', quoteId, at, count });

for (const [name, make] of implementations) {
    describe(`EventStore contract (${name})`, () => {
        it('an unknown stream reads as empty', () => {
            assert.deepEqual(make().read('quote-nobody'), []);
        });

        it('appends at the expected version and reads back with seq from 1', () => {
            const store = make();
            assert.deepEqual(store.append('quote-a', 0, [started('a'), trucks('a', 1)]), { ok: true, value: undefined });
            assert.deepEqual(store.read('quote-a'), [{ ...started('a'), seq: 1 }, { ...trucks('a', 1), seq: 2 }]);
        });

        it('refuses a stale expected version and writes nothing', () => {
            const store = make();
            store.append('quote-a', 0, [started('a')]);
            assert.deepEqual(store.append('quote-a', 0, [trucks('a', 1)]), { ok: false, error: CONFLICT });
            assert.deepEqual(store.append('quote-a', 5, [trucks('a', 1)]), { ok: false, error: CONFLICT });
            assert.equal(store.read('quote-a').length, 1);
        });

        it('streams are independent, and the feed returns all of them in the order they happened', () => {
            const store = make();
            store.append('quote-a', 0, [started('a')]);
            store.append('quote-b', 0, [started('b')]);
            store.append('quote-a', 1, [trucks('a', 2)]);
            assert.deepEqual(store.read('quote-b'), [{ ...started('b'), seq: 1 }]);
            assert.deepEqual(store.readAll().map((e) => `${e.quoteId}#${e.seq}`), ['a#1', 'b#1', 'a#2']);
        });
    });
}
