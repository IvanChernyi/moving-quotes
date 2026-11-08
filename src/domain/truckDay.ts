// The TruckDay aggregate: one per date, shared by every quote moving that day.
// Rule it protects: the trucks reserved never exceed the fleet that day.
// Pure: the fleet size is handed in as reference data.

import { z } from 'zod';
import { Result, Stored } from './result';
import { Now } from './time';

// ---- events ---------------------------------------------------------------------------------

const Base = z.object({ date: z.string(), at: z.string() });

export const TruckDayEventSchema = z.discriminatedUnion('type', [
    Base.extend({ type: z.literal('TrucksReserved'), quoteId: z.string(), trucks: z.number().int().positive() }),
    Base.extend({ type: z.literal('TrucksReleased'), quoteId: z.string(), trucks: z.number().int().positive() }),
]);

export type TruckDayEvent = z.infer<typeof TruckDayEventSchema>;

// ---- the aggregate ----------------------------------------------------------------------------

export interface Reservation {
    quoteId: string;
    trucks: number;
}

export interface TruckDay {
    date: string;
    reservations: Reservation[];
}

// Left fold. An empty stream is a day nobody booked; the app layer supplies that empty day.
export function foldTruckDay(events: Stored<TruckDayEvent>[]): Result<TruckDay> {
    const first = events[0];
    if (!first) return { ok: false, error: 'no events' };
    let reservations: Reservation[] = [];
    for (const event of events) {
        if (event.type === 'TrucksReserved') reservations = [...reservations, { quoteId: event.quoteId, trucks: event.trucks }];
        else if (event.type === 'TrucksReleased') reservations = reservations.filter((r) => r.quoteId !== event.quoteId);
    }
    return { ok: true, value: { date: first.date, reservations } };
}

export function reservedTrucks(day: TruckDay): number {
    let total = 0;
    for (const reservation of day.reservations) total += reservation.trucks;
    return total;
}

export function freeTrucks(day: TruckDay, fleetSize: number): number {
    return fleetSize - reservedTrucks(day);
}

// ---- business verbs ---------------------------------------------------------------------------

export function reserveTrucks(day: TruckDay, quoteId: string, trucks: number, fleetSize: number, now: Now): Result<TruckDayEvent[]> {
    if (!(Number.isSafeInteger(trucks) && trucks > 0)) return { ok: false, error: 'the number of trucks must be a positive whole number' };
    if (day.reservations.some((r) => r.quoteId === quoteId)) return { ok: false, error: `this quote already holds trucks on ${day.date}` };
    const free = freeTrucks(day, fleetSize);
    if (trucks > free) return { ok: false, error: `only ${free} truck(s) free on ${day.date}` };
    return { ok: true, value: [{ type: 'TrucksReserved', date: day.date, at: now.at, quoteId, trucks }] };
}

export function releaseTrucks(day: TruckDay, quoteId: string, now: Now): Result<TruckDayEvent[]> {
    const held = day.reservations.find((r) => r.quoteId === quoteId);
    if (!held) return { ok: false, error: `this quote holds no trucks on ${day.date}` };
    return { ok: true, value: [{ type: 'TrucksReleased', date: day.date, at: now.at, quoteId, trucks: held.trucks }] };
}
