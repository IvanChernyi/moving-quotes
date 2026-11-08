// Command tests: real implementations of every socket, no mocks.
// In-memory stores, a fixed distance, test reference data (2 trucks a day), a fixed clock.
// Two small store plugs below simulate the world misbehaving: another window, another customer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/commands/quotes';
import { CONFLICT } from '../src/domain/eventStore';
import { QuoteEvent } from '../src/domain/quote';
import { Result } from '../src/domain/result';
import { TruckDayEvent } from '../src/domain/truckDay';
import { FixedDistanceSource } from '../src/maps/fixedDistanceSource';
import { InMemoryEventStore } from '../src/storage/inMemoryEventStore';
import { nowOn, testReference } from './support';

function makeDeps(overrides: Partial<C.Deps> = {}): C.Deps {
    let next = 0;
    return {
        quotes: new InMemoryEventStore<QuoteEvent>(),
        days: new InMemoryEventStore<TruckDayEvent>(),
        distances: new FixedDistanceSource(50, ['Nowhere']),
        reference: testReference,
        newId: () => `q${++next}`,
        now: () => nowOn('2026-11-08'),
        ...overrides,
    };
}

function ok<T>(result: Result<T>): T {
    assert.ok(result.ok, result.ok ? '' : result.error);
    return result.value;
}

// A draft with one box, a route, a date and the trucks: everything confirm needs.
async function readyQuote(deps: C.Deps, moveDate: string, trucks: number): Promise<string> {
    const { quoteId } = ok(C.startQuote(deps));
    ok(C.addItem(deps, quoteId, { item: 'Box', quantity: 1, weightKg: undefined }));
    ok(await C.chooseAddresses(deps, quoteId, { pickup: '1 Old Street', delivery: '9 New Road' }));
    ok(C.chooseMoveDate(deps, quoteId, moveDate));
    ok(C.chooseTrucks(deps, quoteId, trucks));
    return quoteId;
}

const freeOn = (deps: C.Deps, date: string): number => {
    const day = ok(C.loadDay(deps, date)).state;
    return testReference.fleetSize(date) - day.reservations.reduce((n, r) => n + r.trucks, 0);
};

describe('a quote from start to confirmation', () => {
    it('records the fetched distance, reserves the trucks and locks the price', async () => {
        const deps = makeDeps();
        const quoteId = await readyQuote(deps, '2026-11-20', 1);

        assert.equal(ok(C.loadQuote(deps, quoteId)).state.route?.distanceKm, 50);
        const { priceCents } = ok(C.confirmQuote(deps, quoteId));

        const quote = ok(C.loadQuote(deps, quoteId)).state;
        assert.equal(quote.status, 'confirmed');
        assert.equal(quote.priceCents, priceCents);
        assert.equal(freeOn(deps, '2026-11-20'), 1);
    });

    it('an address the maps service cannot find fails with its message and records nothing', async () => {
        const deps = makeDeps();
        const { quoteId } = ok(C.startQuote(deps));
        assert.deepEqual(await C.chooseAddresses(deps, quoteId, { pickup: 'Nowhere', delivery: '9 New Road' }), {
            ok: false, error: 'the maps service could not find "Nowhere"',
        });
        assert.equal(deps.quotes.read(C.quoteStream(quoteId)).length, 1);
    });
});

describe('the fleet is shared: TruckDay', () => {
    it('a second quote cannot take trucks the first one already has', async () => {
        const deps = makeDeps();
        const first = await readyQuote(deps, '2026-11-20', 2);   // the whole fleet
        const second = await readyQuote(deps, '2026-11-20', 1);
        ok(C.confirmQuote(deps, first));

        assert.deepEqual(C.confirmQuote(deps, second), { ok: false, error: 'only 0 truck(s) free on 2026-11-20' });
        assert.equal(ok(C.loadQuote(deps, second)).state.status, 'draft');
    });

    it('a competitor books between our read and our write: the retry sees it and refuses', async () => {
        // a day store where another customer's reservation lands just before ours
        class CompetitorGetsThereFirst extends InMemoryEventStore<TruckDayEvent> {
            private raced = false;
            append(stream: string, expectedSeq: number, events: TruckDayEvent[]): Result<void> {
                if (!this.raced) {
                    this.raced = true;
                    super.append(stream, expectedSeq, [{ type: 'TrucksReserved', date: '2026-11-20', at: 'x', quoteId: 'competitor', trucks: 2 }]);
                }
                return super.append(stream, expectedSeq, events);   // now stale: a real CONFLICT from a real store
            }
        }
        const deps = makeDeps({ days: new CompetitorGetsThereFirst() });
        const quoteId = await readyQuote(deps, '2026-11-20', 1);

        assert.deepEqual(C.confirmQuote(deps, quoteId), { ok: false, error: 'only 0 truck(s) free on 2026-11-20' });
        assert.equal(ok(C.loadQuote(deps, quoteId)).state.status, 'draft');
    });

    it('if locking the quote fails after the trucks were reserved, the trucks are given back', async () => {
        // a quote store where another window changes the quote while we confirm
        class AnotherWindow extends InMemoryEventStore<QuoteEvent> {
            append(stream: string, expectedSeq: number, events: QuoteEvent[]): Result<void> {
                if (events[0]?.type === 'QuoteConfirmed') return { ok: false, error: CONFLICT };
                return super.append(stream, expectedSeq, events);
            }
        }
        const deps = makeDeps({ quotes: new AnotherWindow() });
        const quoteId = await readyQuote(deps, '2026-11-20', 1);

        assert.deepEqual(C.confirmQuote(deps, quoteId), { ok: false, error: 'the quote changed while confirming; review it and confirm again' });
        assert.deepEqual(deps.days.read(C.dayStream('2026-11-20')).map((e) => e.type), ['TrucksReserved', 'TrucksReleased']);
        assert.equal(freeOn(deps, '2026-11-20'), 2);
    });
});

describe('cancelling', () => {
    it('more than 7 days ahead: the quote is cancelled and its trucks are free for someone else', async () => {
        const deps = makeDeps();
        const first = await readyQuote(deps, '2026-11-20', 2);
        const second = await readyQuote(deps, '2026-11-20', 2);
        ok(C.confirmQuote(deps, first));

        ok(C.cancelQuote(deps, first));
        assert.equal(ok(C.loadQuote(deps, first)).state.status, 'cancelled');
        assert.equal(freeOn(deps, '2026-11-20'), 2);
        ok(C.confirmQuote(deps, second));
    });

    it('7 days ahead: refused, and the trucks stay booked', async () => {
        const deps = makeDeps();
        const quoteId = await readyQuote(deps, '2026-11-15', 1);
        ok(C.confirmQuote(deps, quoteId));

        assert.equal(C.cancelQuote(deps, quoteId).ok, false);
        assert.equal(freeOn(deps, '2026-11-15'), 1);
    });
});

describe('another window', () => {
    it('a write based on an old read is refused instead of overwriting', () => {
        const deps = makeDeps();
        const { quoteId } = ok(C.startQuote(deps));
        const stale = ok(C.loadQuote(deps, quoteId)).version;
        ok(C.chooseTrucks(deps, quoteId, 1));   // someone else moves the stream on

        assert.deepEqual(
            deps.quotes.append(C.quoteStream(quoteId), stale, [{ type: 'TrucksChosen', quoteId, at: 'x', count: 2 }]),
            { ok: false, error: CONFLICT },
        );
    });
});
