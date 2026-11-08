// Domain tests for the TruckDay aggregate: pure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Stored } from '../src/domain/result';
import * as D from '../src/domain/truckDay';
import { nowOn } from './support';

const now = nowOn('2026-11-08');
const empty: D.TruckDay = { date: '2026-11-20', reservations: [] };

describe('reserving trucks', () => {
    it('reserves within the fleet', () => {
        assert.deepEqual(D.reserveTrucks(empty, 'q1', 2, 4, now), {
            ok: true, value: [{ type: 'TrucksReserved', date: '2026-11-20', at: now.at, quoteId: 'q1', trucks: 2 }],
        });
    });

    it('refuses more trucks than are free, saying how many are', () => {
        const day: D.TruckDay = { date: '2026-11-20', reservations: [{ quoteId: 'q1', trucks: 3 }] };
        assert.deepEqual(D.reserveTrucks(day, 'q2', 2, 4, now), { ok: false, error: 'only 1 truck(s) free on 2026-11-20' });
        assert.equal(D.reserveTrucks(day, 'q2', 1, 4, now).ok, true, 'exactly the last truck is fine');
    });

    it('one quote cannot hold two reservations on the same day', () => {
        const day: D.TruckDay = { date: '2026-11-20', reservations: [{ quoteId: 'q1', trucks: 1 }] };
        assert.equal(D.reserveTrucks(day, 'q1', 1, 4, now).ok, false);
    });
});

describe('releasing trucks', () => {
    it('releases what the quote holds, and only that', () => {
        const day: D.TruckDay = { date: '2026-11-20', reservations: [{ quoteId: 'q1', trucks: 2 }] };
        assert.deepEqual(D.releaseTrucks(day, 'q1', now), {
            ok: true, value: [{ type: 'TrucksReleased', date: '2026-11-20', at: now.at, quoteId: 'q1', trucks: 2 }],
        });
        assert.deepEqual(D.releaseTrucks(day, 'q2', now), { ok: false, error: 'this quote holds no trucks on 2026-11-20' });
    });
});

describe('folding a day', () => {
    it('nets reservations against releases', () => {
        const events: Stored<D.TruckDayEvent>[] = [
            { seq: 1, type: 'TrucksReserved', date: '2026-11-20', at: now.at, quoteId: 'q1', trucks: 2 },
            { seq: 2, type: 'TrucksReserved', date: '2026-11-20', at: now.at, quoteId: 'q2', trucks: 1 },
            { seq: 3, type: 'TrucksReleased', date: '2026-11-20', at: now.at, quoteId: 'q1', trucks: 2 },
        ];
        const day = D.foldTruckDay(events);
        assert.ok(day.ok);
        assert.deepEqual(day.value.reservations, [{ quoteId: 'q2', trucks: 1 }]);
        assert.equal(D.freeTrucks(day.value, 4), 3);
    });
});
