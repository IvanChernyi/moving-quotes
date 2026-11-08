// Domain tests for the Quote aggregate: pure. Events in, events out. No store, no clock, no mocks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/domain/quote';
import { Result, Stored } from '../src/domain/result';
import { daysBetween, isDate } from '../src/domain/time';
import { nowOn, testCatalog, testRates } from './support';

const now = nowOn('2026-11-08');

type Step = (quote: Q.Quote) => Result<Q.QuoteEvent[]>;

// Plays verbs the way the app layer does: fold, decide, append the new events, fold again.
function play(...steps: Step[]): { quote: Q.Quote; events: Q.QuoteEvent[] } {
    const started = Q.startQuote('q1', now);
    assert.ok(started.ok);
    let events: Q.QuoteEvent[] = started.value;
    for (const step of steps) {
        const decided = step(fold(events));
        assert.ok(decided.ok, decided.ok ? '' : decided.error);
        events = [...events, ...decided.value];
    }
    return { quote: fold(events), events };
}

function fold(events: Q.QuoteEvent[]): Q.Quote {
    const stored: Stored<Q.QuoteEvent>[] = events.map((e, i) => ({ ...e, seq: i + 1 }));
    const folded = Q.foldQuote(stored);
    assert.ok(folded.ok);
    return folded.value;
}

const add = (item: string, quantity: number, weightKg?: number): Step => (q) => Q.addItem(q, { item, quantity, weightKg }, testCatalog, now);
const route = (distanceKm = 50): Step => (q) => Q.chooseAddresses(q, { pickup: '1 Old Street', delivery: '9 New Road', distanceKm }, now);
const date = (d: string): Step => (q) => Q.chooseMoveDate(q, d, now);
const trucks = (n: number): Step => (q) => Q.chooseTrucks(q, n, now);
const confirm: Step = (q) => Q.confirmQuote(q, testRates, now);

// 2 sofas (60) + 10 boxes (15) = 270 kg, 50 km, 1 truck, move in 12 days
const ready: Step[] = [add('Sofa', 2), add('Box', 10), route(50), date('2026-11-20'), trucks(1)];

describe('starting and folding', () => {
    it('a new quote is an empty draft named after its id', () => {
        const { quote } = play();
        assert.equal(quote.id, 'q1');
        assert.equal(quote.status, 'draft');
        assert.deepEqual(quote.lines, []);
    });

    it('a stream that does not begin with QuoteStarted is refused', () => {
        const folded = Q.foldQuote([{ seq: 1, type: 'TrucksChosen', quoteId: 'q1', at: now.at, count: 1 }]);
        assert.equal(folded.ok, false);
    });
});

describe('items', () => {
    it('adding an item copies the catalogue default weight onto the event', () => {
        const { events } = play(add('Sofa', 2));
        assert.deepEqual(events[1], { type: 'ItemAdded', quoteId: 'q1', at: now.at, lineNo: 1, item: 'Sofa', quantity: 2, weightKg: 60 });
    });

    it('the customer can give their own weight', () => {
        const { quote } = play(add('Sofa', 1, 85));
        assert.equal(quote.lines[0].weightKg, 85);
    });

    it('line numbers count up and a removed number is never reused', () => {
        const { quote } = play(add('Sofa', 1), add('Box', 1), (q) => Q.removeItem(q, 2, now), add('Piano', 1));
        assert.deepEqual(quote.lines.map((l) => l.lineNo), [1, 3]);
    });

    it('refuses an item that is not in the catalogue, and quantities that are not positive whole numbers', () => {
        const { quote } = play();
        assert.equal(Q.addItem(quote, { item: 'Spaceship', quantity: 1, weightKg: undefined }, testCatalog, now).ok, false);
        for (const quantity of [0, -1, 1.5, NaN]) {
            assert.equal(Q.addItem(quote, { item: 'Box', quantity, weightKg: undefined }, testCatalog, now).ok, false, `quantity ${quantity}`);
        }
    });

    it('changes the weight of an existing line and refuses one that does not exist', () => {
        const { quote } = play(add('Sofa', 1), (q) => Q.changeItemWeight(q, 1, 70, now));
        assert.equal(quote.lines[0].weightKg, 70);
        assert.deepEqual(Q.changeItemWeight(quote, 9, 70, now), { ok: false, error: 'there is no line 9' });
    });

    it('a line cannot be removed twice', () => {
        const { quote } = play(add('Sofa', 1), (q) => Q.removeItem(q, 1, now));
        assert.deepEqual(Q.removeItem(quote, 1, now), { ok: false, error: 'there is no line 1' });
    });
});

describe('move date', () => {
    it('must be a real date after today', () => {
        const { quote } = play();
        assert.equal(Q.chooseMoveDate(quote, '2026-11-08', now).ok, false, 'today');
        assert.equal(Q.chooseMoveDate(quote, '2026-11-01', now).ok, false, 'past');
        assert.equal(Q.chooseMoveDate(quote, '2026-02-30', now).ok, false, 'not a date');
        assert.equal(Q.chooseMoveDate(quote, '2026-11-09', now).ok, true, 'tomorrow');
    });
});

describe('estimate', () => {
    it('adds base, trucks, distance and labour', () => {
        const { quote } = play(...ready);
        // 270 kg → 2 movers (minimum), hours = max(2, ceil(270 / (2 × 100))) = 2
        assert.deepEqual(Q.estimate(quote, testRates).breakdown, {
            baseCents: 10_000,
            trucksCents: 20_000,                 // 1 truck
            distanceCents: 1 * 50 * 100,         // trucks × km × rate
            labourCents: 2 * 2 * 5_000,          // movers × hours × rate
            trucks: 1, movers: 2, hours: 2,
            totalCents: 10_000 + 20_000 + 5_000 + 20_000,
        });
    });

    it('suggests movers from the weight, and the customer\'s choice wins', () => {
        const { quote } = play(add('Piano', 4));                 // 1000 kg → ceil(1000 / 300) = 4 movers
        assert.equal(Q.suggestedMovers(quote, testRates), 4);
        const chosen = play(add('Piano', 4), (q) => Q.chooseMovers(q, 6, now)).quote;
        assert.equal(Q.moversFor(chosen, testRates), 6);
    });

    it('lists what is still missing', () => {
        const { quote } = play(add('Box', 1));
        assert.deepEqual(Q.estimate(quote, testRates).missing, ['pickup and delivery addresses', 'a move date', 'the number of trucks']);
    });
});

describe('confirming (rule 2) and the promise it makes (rule 1)', () => {
    it('confirms with the estimated price, the move date and the trucks on the event', () => {
        const { quote } = play(...ready);
        assert.deepEqual(confirm(quote), {
            ok: true,
            value: [{
                type: 'QuoteConfirmed', quoteId: 'q1', at: now.at, priceCents: 55_000,
                breakdown: Q.estimate(quote, testRates).breakdown, moveDate: '2026-11-20', trucks: 1,
            }],
        });
    });

    it('refuses with a list of what is missing', () => {
        const { quote } = play(add('Box', 1));
        assert.deepEqual(confirm(quote), { ok: false, error: 'to confirm, add pickup and delivery addresses, a move date, the number of trucks' });
    });

    it('refuses when the trucks cannot carry the weight', () => {
        const { quote } = play(add('Piano', 5), route(), date('2026-11-20'), trucks(1));   // 1250 kg, one 1000 kg truck
        assert.deepEqual(confirm(quote), { ok: false, error: '1 truck(s) cannot carry 1250 kg; choose more trucks' });
        assert.equal(confirm(play(add('Piano', 5), route(), date('2026-11-20'), trucks(2)).quote).ok, true);
    });

    it('a confirmed quote can no longer change', () => {
        const { quote } = play(...ready, confirm);
        assert.equal(quote.status, 'confirmed');
        assert.equal(quote.priceCents, 55_000);
        assert.deepEqual(Q.addItem(quote, { item: 'Box', quantity: 1, weightKg: undefined }, testCatalog, now), {
            ok: false, error: 'the quote is confirmed and can no longer change',
        });
        assert.equal(Q.chooseTrucks(quote, 2, now).ok, false);
        assert.equal(confirm(quote).ok, false);
    });
});

describe('cancelling (rule 4): more than 7 days notice', () => {
    const confirmedFor = (moveDate: string): Q.Quote =>
        play(add('Box', 1), route(), date(moveDate), trucks(1), confirm).quote;

    it('8 days before the move: allowed, and the event carries the date and trucks to release', () => {
        assert.deepEqual(Q.cancelQuote(confirmedFor('2026-11-16'), now), {
            ok: true, value: [{ type: 'QuoteCancelled', quoteId: 'q1', at: now.at, moveDate: '2026-11-16', trucks: 1 }],
        });
    });

    it('exactly 7 days before: refused', () => {
        assert.deepEqual(Q.cancelQuote(confirmedFor('2026-11-15'), now), {
            ok: false, error: "the move is in 7 day(s); cancelling needs more than 7 days' notice",
        });
    });

    it('6 days before: refused', () => {
        assert.equal(Q.cancelQuote(confirmedFor('2026-11-14'), now).ok, false);
    });

    it('a draft cannot be cancelled, and nothing can be cancelled twice', () => {
        assert.equal(Q.cancelQuote(play(...ready).quote, now).ok, false);
        const cancelled = play(add('Box', 1), route(), date('2026-11-30'), trucks(1), confirm, (q) => Q.cancelQuote(q, now)).quote;
        assert.equal(cancelled.status, 'cancelled');
        assert.deepEqual(Q.cancelQuote(cancelled, now), { ok: false, error: 'the quote is already cancelled' });
    });
});

describe('dates', () => {
    it('counts whole days across a month end and rejects impossible dates', () => {
        assert.equal(daysBetween('2026-11-28', '2026-12-05'), 7);
        assert.equal(isDate('2026-02-29'), false);
        assert.equal(isDate('2028-02-29'), true);
    });
});
