// The Quote aggregate. Pure: no clock, no ids minted, no I/O, no promises.
//
// Rules it protects:
//   1. only a draft can change; a confirmed quote is a promise
//   2. confirming needs items, both addresses, a future move date, trucks, and enough truck capacity
//   3. a line can be edited or removed only if it exists and was not removed already
//   4. only a confirmed quote can be cancelled, and only if the move is more than 7 days away

import { z } from 'zod';
import { CatalogItem, RateCard } from './reference';
import { Result, Stored } from './result';
import { daysBetween, isDate, Now } from './time';

export const CANCEL_NOTICE_DAYS = 7;

// ---- events: past-tense facts -------------------------------------------------------

const Base = z.object({ quoteId: z.string(), at: z.string() });
const positiveInt = z.number().int().positive();

export const BreakdownSchema = z.object({
    baseCents: z.number().int(),
    trucksCents: z.number().int(),
    distanceCents: z.number().int(),
    labourCents: z.number().int(),
    trucks: z.number().int(),
    movers: z.number().int(),
    hours: z.number().int(),
    totalCents: z.number().int(),
});

export const QuoteEventSchema = z.discriminatedUnion('type', [
    Base.extend({ type: z.literal('QuoteStarted') }),
    Base.extend({ type: z.literal('ItemAdded'), lineNo: positiveInt, item: z.string(), quantity: positiveInt, weightKg: positiveInt }),
    Base.extend({ type: z.literal('ItemWeightChanged'), lineNo: positiveInt, weightKg: positiveInt }),
    Base.extend({ type: z.literal('ItemRemoved'), lineNo: positiveInt }),
    Base.extend({ type: z.literal('AddressesChosen'), pickup: z.string(), delivery: z.string(), distanceKm: positiveInt }),
    Base.extend({ type: z.literal('MoveDateChosen'), date: z.string() }),
    Base.extend({ type: z.literal('TrucksChosen'), count: positiveInt }),
    Base.extend({ type: z.literal('MoversChosen'), count: positiveInt }),
    Base.extend({ type: z.literal('QuoteConfirmed'), priceCents: positiveInt, breakdown: BreakdownSchema, moveDate: z.string(), trucks: positiveInt }),
    Base.extend({ type: z.literal('QuoteCancelled'), moveDate: z.string(), trucks: positiveInt }),
]);

export type QuoteEvent = z.infer<typeof QuoteEventSchema>;
export type QuoteConfirmedEvent = Extract<QuoteEvent, { type: 'QuoteConfirmed' }>;
export type QuoteCancelledEvent = Extract<QuoteEvent, { type: 'QuoteCancelled' }>;
export type Breakdown = z.infer<typeof BreakdownSchema>;

// ---- the aggregate ----------------------------------------------------------------------

export type QuoteStatus = 'draft' | 'confirmed' | 'cancelled';

export interface QuoteLine {
    lineNo: number;
    item: string;
    quantity: number;
    weightKg: number;   // per unit
}

export interface Route {
    pickup: string;
    delivery: string;
    distanceKm: number;
}

export interface Quote {
    id: string;
    status: QuoteStatus;
    lines: QuoteLine[];
    linesAdded: number;                 // the next line is linesAdded + 1; a removed number is never reused
    route: Route | undefined;
    moveDate: string | undefined;
    trucks: number | undefined;
    moversOverride: number | undefined;
    priceCents: number | undefined;     // set when confirmed: the promise
}

// Left fold: events in, aggregate out. The id comes from the events.
export function foldQuote(events: Stored<QuoteEvent>[]): Result<Quote> {
    const first = events[0];
    if (!first || first.type !== 'QuoteStarted') return { ok: false, error: 'a quote must begin with QuoteStarted' };

    let quote: Quote = {
        id: first.quoteId,
        status: 'draft',
        lines: [],
        linesAdded: 0,
        route: undefined,
        moveDate: undefined,
        trucks: undefined,
        moversOverride: undefined,
        priceCents: undefined,
    };
    for (const event of events) quote = apply(quote, event);
    return { ok: true, value: quote };
}

function apply(quote: Quote, event: QuoteEvent): Quote {
    switch (event.type) {
        case 'QuoteStarted':
            return quote;
        case 'ItemAdded':
            return {
                ...quote,
                lines: [...quote.lines, { lineNo: event.lineNo, item: event.item, quantity: event.quantity, weightKg: event.weightKg }],
                linesAdded: quote.linesAdded + 1,
            };
        case 'ItemWeightChanged':
            return { ...quote, lines: quote.lines.map((line) => (line.lineNo === event.lineNo ? { ...line, weightKg: event.weightKg } : line)) };
        case 'ItemRemoved':
            return { ...quote, lines: quote.lines.filter((line) => line.lineNo !== event.lineNo) };
        case 'AddressesChosen':
            return { ...quote, route: { pickup: event.pickup, delivery: event.delivery, distanceKm: event.distanceKm } };
        case 'MoveDateChosen':
            return { ...quote, moveDate: event.date };
        case 'TrucksChosen':
            return { ...quote, trucks: event.count };
        case 'MoversChosen':
            return { ...quote, moversOverride: event.count };
        case 'QuoteConfirmed':
            return { ...quote, status: 'confirmed', priceCents: event.priceCents };
        case 'QuoteCancelled':
            return { ...quote, status: 'cancelled' };
    }
}

// ---- derived values: computed, never stored ----------------------------------------------

export function totalWeightKg(quote: Quote): number {
    let total = 0;
    for (const line of quote.lines) total += line.quantity * line.weightKg;
    return total;
}

export function suggestedTrucks(quote: Quote, rates: RateCard): number {
    return Math.max(1, Math.ceil(totalWeightKg(quote) / rates.truckCapacityKg));
}

export function suggestedMovers(quote: Quote, rates: RateCard): number {
    return Math.max(rates.minMovers, Math.ceil(totalWeightKg(quote) / rates.kgPerSuggestedMover));
}

// What the price is computed with: the customer's choice if made, otherwise the app's suggestion.
export function trucksFor(quote: Quote, rates: RateCard): number {
    return quote.trucks ?? suggestedTrucks(quote, rates);
}

export function moversFor(quote: Quote, rates: RateCard): number {
    return quote.moversOverride ?? suggestedMovers(quote, rates);
}

export function capacityShortKg(quote: Quote, rates: RateCard): number {
    return Math.max(0, totalWeightKg(quote) - trucksFor(quote, rates) * rates.truckCapacityKg);
}

export interface Estimate {
    breakdown: Breakdown;
    missing: string[];   // what still has to be chosen before the quote can be confirmed
}

export function estimate(quote: Quote, rates: RateCard): Estimate {
    const weight = totalWeightKg(quote);
    const trucks = trucksFor(quote, rates);
    const movers = moversFor(quote, rates);
    const hours = Math.max(rates.minHours, Math.ceil(weight / (movers * rates.kgPerMoverHour)));
    const distanceKm = quote.route?.distanceKm ?? 0;

    const baseCents = rates.baseFeeCents;
    const trucksCents = trucks * rates.perTruckCents;
    const distanceCents = trucks * distanceKm * rates.perKmPerTruckCents;
    const labourCents = movers * hours * rates.perMoverHourCents;

    return {
        breakdown: {
            baseCents, trucksCents, distanceCents, labourCents,
            trucks, movers, hours,
            totalCents: baseCents + trucksCents + distanceCents + labourCents,
        },
        missing: missingParts(quote),
    };
}

function missingParts(quote: Quote): string[] {
    const missing: string[] = [];
    if (quote.lines.length === 0) missing.push('at least one item');
    if (quote.route === undefined) missing.push('pickup and delivery addresses');
    if (quote.moveDate === undefined) missing.push('a move date');
    if (quote.trucks === undefined) missing.push('the number of trucks');
    return missing;
}

// ---- business verbs: (aggregate, input, now) → the events that happened ---------------------

function isPositiveInt(n: number): boolean {
    return Number.isSafeInteger(n) && n > 0;
}

function draftOnly(quote: Quote): Result<void> {
    if (quote.status !== 'draft') return { ok: false, error: `the quote is ${quote.status} and can no longer change` };
    return { ok: true, value: undefined };
}

// The one verb without an aggregate: the quote does not exist yet.
export function startQuote(quoteId: string, now: Now): Result<QuoteEvent[]> {
    if (!quoteId) return { ok: false, error: 'a quote needs an id' };
    return { ok: true, value: [{ type: 'QuoteStarted', quoteId, at: now.at }] };
}

// What the customer asks to move. weightKg is per unit; undefined means the catalogue default.
export interface ItemToMove {
    item: string;
    quantity: number;
    weightKg: number | undefined;
}

export function addItem(quote: Quote, toMove: ItemToMove, catalog: CatalogItem[], now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    const known = catalog.find((entry) => entry.name === toMove.item);
    if (!known) return { ok: false, error: `${toMove.item} is not in the catalogue` };
    if (!isPositiveInt(toMove.quantity)) return { ok: false, error: 'the quantity must be a positive whole number' };
    const weightKg = toMove.weightKg ?? known.defaultWeightKg;   // the default is copied onto the fact
    if (!isPositiveInt(weightKg)) return { ok: false, error: 'the weight must be a positive whole number of kg' };

    return {
        ok: true,
        value: [{ type: 'ItemAdded', quoteId: quote.id, at: now.at, lineNo: quote.linesAdded + 1, item: known.name, quantity: toMove.quantity, weightKg }],
    };
}

export function changeItemWeight(quote: Quote, lineNo: number, weightKg: number, now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    if (!quote.lines.some((line) => line.lineNo === lineNo)) return { ok: false, error: `there is no line ${lineNo}` };
    if (!isPositiveInt(weightKg)) return { ok: false, error: 'the weight must be a positive whole number of kg' };
    return { ok: true, value: [{ type: 'ItemWeightChanged', quoteId: quote.id, at: now.at, lineNo, weightKg }] };
}

export function removeItem(quote: Quote, lineNo: number, now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    if (!quote.lines.some((line) => line.lineNo === lineNo)) return { ok: false, error: `there is no line ${lineNo}` };
    return { ok: true, value: [{ type: 'ItemRemoved', quoteId: quote.id, at: now.at, lineNo }] };
}

// The route arrives with its distance already fetched: the distance at that moment is part of the fact.
export function chooseAddresses(quote: Quote, route: Route, now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    const pickup = route.pickup.trim();
    const delivery = route.delivery.trim();
    if (!(pickup && delivery)) return { ok: false, error: 'both a pickup and a delivery address are needed' };
    if (!isPositiveInt(route.distanceKm)) return { ok: false, error: 'the distance must be a positive whole number of km' };
    return { ok: true, value: [{ type: 'AddressesChosen', quoteId: quote.id, at: now.at, pickup, delivery, distanceKm: route.distanceKm }] };
}

export function chooseMoveDate(quote: Quote, date: string, now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    if (!isDate(date)) return { ok: false, error: `${date} is not a date` };
    if (!(daysBetween(now.today, date) >= 1)) return { ok: false, error: 'the move date must be after today' };
    return { ok: true, value: [{ type: 'MoveDateChosen', quoteId: quote.id, at: now.at, date }] };
}

export function chooseTrucks(quote: Quote, count: number, now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    if (!isPositiveInt(count)) return { ok: false, error: 'the number of trucks must be a positive whole number' };
    return { ok: true, value: [{ type: 'TrucksChosen', quoteId: quote.id, at: now.at, count }] };
}

export function chooseMovers(quote: Quote, count: number, now: Now): Result<QuoteEvent[]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    if (!isPositiveInt(count)) return { ok: false, error: 'the number of movers must be a positive whole number' };
    return { ok: true, value: [{ type: 'MoversChosen', quoteId: quote.id, at: now.at, count }] };
}

// Rule 2. Exactly one event, and the type says so: the app layer reads the date and trucks off it.
export function confirmQuote(quote: Quote, rates: RateCard, now: Now): Result<[QuoteConfirmedEvent]> {
    const draft = draftOnly(quote);
    if (!draft.ok) return draft;
    const { moveDate, trucks } = quote;
    if (quote.lines.length === 0 || quote.route === undefined || moveDate === undefined || trucks === undefined) {
        return { ok: false, error: `to confirm, add ${missingParts(quote).join(', ')}` };
    }
    if (!(daysBetween(now.today, moveDate) >= 1)) return { ok: false, error: 'the move date has passed; choose a new one' };
    if (capacityShortKg(quote, rates) > 0) {
        return { ok: false, error: `${trucks} truck(s) cannot carry ${totalWeightKg(quote)} kg; choose more trucks` };
    }
    const { breakdown } = estimate(quote, rates);
    return {
        ok: true,
        value: [{ type: 'QuoteConfirmed', quoteId: quote.id, at: now.at, priceCents: breakdown.totalCents, breakdown, moveDate, trucks }],
    };
}

// Rule 4. More than 7 days' notice: exactly 7 days is refused.
export function cancelQuote(quote: Quote, now: Now): Result<[QuoteCancelledEvent]> {
    if (quote.status === 'cancelled') return { ok: false, error: 'the quote is already cancelled' };
    if (quote.status === 'draft') return { ok: false, error: 'only a confirmed quote can be cancelled; a draft can simply be left' };
    const { moveDate, trucks } = quote;
    if (moveDate === undefined || trucks === undefined) return { ok: false, error: 'a confirmed quote must have a move date and trucks' };
    const daysLeft = daysBetween(now.today, moveDate);
    if (!(daysLeft > CANCEL_NOTICE_DAYS)) {
        return { ok: false, error: `the move is in ${daysLeft} day(s); cancelling needs more than ${CANCEL_NOTICE_DAYS} days' notice` };
    }
    return { ok: true, value: [{ type: 'QuoteCancelled', quoteId: quote.id, at: now.at, moveDate, trucks }] };
}
