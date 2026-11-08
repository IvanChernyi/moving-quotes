// commands (app layer): load → business verb → append at the version that was read.
// Feeds the deps, works only through interfaces, holds no business rules. Async stops here.

import * as Quotes from '../domain/quote';
import * as TruckDays from '../domain/truckDay';
import { DistanceSource } from '../domain/distanceSource';
import { CONFLICT, EventStore } from '../domain/eventStore';
import { ReferenceData } from '../domain/reference';
import { Result } from '../domain/result';
import { Now } from '../domain/time';

export interface Deps {
    quotes: EventStore<Quotes.QuoteEvent>;
    days: EventStore<TruckDays.TruckDayEvent>;
    distances: DistanceSource;
    reference: ReferenceData;
    newId: () => string;
    now: () => Now;
}

export const quoteStream = (quoteId: string): string => `quote-${quoteId}`;
export const dayStream = (date: string): string => `truckday-${date}`;

const DAY_RETRIES = 3;

// An aggregate as of a version: the version is the seq of the last event it was folded from.
interface AsOf<A> {
    state: A;
    version: number;
}

export function loadQuote(deps: Deps, quoteId: string): Result<AsOf<Quotes.Quote>> {
    const events = deps.quotes.read(quoteStream(quoteId));
    const last = events[events.length - 1];
    if (!last) return { ok: false, error: `there is no quote ${quoteId}` };
    const quote = Quotes.foldQuote(events);
    if (!quote.ok) return quote;
    return { ok: true, value: { state: quote.value, version: last.seq } };
}

// A day nobody has booked has no events yet: it is an empty day, not a missing one.
export function loadDay(deps: Deps, date: string): Result<AsOf<TruckDays.TruckDay>> {
    const events = deps.days.read(dayStream(date));
    const last = events[events.length - 1];
    if (!last) return { ok: true, value: { state: { date, reservations: [] }, version: 0 } };
    const day = TruckDays.foldTruckDay(events);
    if (!day.ok) return day;
    return { ok: true, value: { state: day.value, version: last.seq } };
}

type QuoteVerb = (quote: Quotes.Quote, now: Now) => Result<Quotes.QuoteEvent[]>;
type DayVerb = (day: TruckDays.TruckDay, now: Now) => Result<TruckDays.TruckDayEvent[]>;

// The shape of every simple quote command. If the quote changed in another window
// between the read and the write, the append is refused instead of silently overwriting.
function onQuote(deps: Deps, quoteId: string, verb: QuoteVerb): Result<void> {
    const loaded = loadQuote(deps, quoteId);
    if (!loaded.ok) return loaded;
    const decided = verb(loaded.value.state, deps.now());
    if (!decided.ok) return decided;
    const appended = deps.quotes.append(quoteStream(quoteId), loaded.value.version, decided.value);
    if (!appended.ok && appended.error === CONFLICT) return { ok: false, error: 'the quote changed in another window; reload and try again' };
    return appended;
}

// The day is contested by every customer, so a conflict is expected: re-read, decide again, retry.
// The retry sees the competitor's reservation, so the rule is checked against the truth.
function onDay(deps: Deps, date: string, verb: DayVerb, now: Now): Result<void> {
    for (let attempt = 0; attempt < DAY_RETRIES; attempt++) {
        const loaded = loadDay(deps, date);
        if (!loaded.ok) return loaded;
        const decided = verb(loaded.value.state, now);
        if (!decided.ok) return decided;
        const appended = deps.days.append(dayStream(date), loaded.value.version, decided.value);
        if (appended.ok || appended.error !== CONFLICT) return appended;
    }
    return { ok: false, error: `the calendar for ${date} is busy; try again` };
}

// ---- quote commands -----------------------------------------------------------------------------

export function startQuote(deps: Deps): Result<{ quoteId: string }> {
    const quoteId = deps.newId();
    const started = Quotes.startQuote(quoteId, deps.now());
    if (!started.ok) return started;
    const appended = deps.quotes.append(quoteStream(quoteId), 0, started.value);
    if (!appended.ok) return appended;
    return { ok: true, value: { quoteId } };
}

export function addItem(deps: Deps, quoteId: string, toMove: Quotes.ItemToMove): Result<void> {
    return onQuote(deps, quoteId, (quote, now) => Quotes.addItem(quote, toMove, deps.reference.catalog, now));
}

export function changeItemWeight(deps: Deps, quoteId: string, lineNo: number, weightKg: number): Result<void> {
    return onQuote(deps, quoteId, (quote, now) => Quotes.changeItemWeight(quote, lineNo, weightKg, now));
}

export function removeItem(deps: Deps, quoteId: string, lineNo: number): Result<void> {
    return onQuote(deps, quoteId, (quote, now) => Quotes.removeItem(quote, lineNo, now));
}

export interface Addresses {
    pickup: string;
    delivery: string;
}

// Fetch the distance first (the slow, unreliable step), then let the quote decide.
export async function chooseAddresses(deps: Deps, quoteId: string, addresses: Addresses): Promise<Result<void>> {
    const distance = await deps.distances.distanceKm(addresses.pickup, addresses.delivery);
    if (!distance.ok) return distance;
    const route = { pickup: addresses.pickup, delivery: addresses.delivery, distanceKm: distance.value };
    return onQuote(deps, quoteId, (quote, now) => Quotes.chooseAddresses(quote, route, now));
}

export function chooseMoveDate(deps: Deps, quoteId: string, date: string): Result<void> {
    return onQuote(deps, quoteId, (quote, now) => Quotes.chooseMoveDate(quote, date, now));
}

export function chooseTrucks(deps: Deps, quoteId: string, count: number): Result<void> {
    return onQuote(deps, quoteId, (quote, now) => Quotes.chooseTrucks(quote, count, now));
}

export function chooseMovers(deps: Deps, quoteId: string, count: number): Result<void> {
    return onQuote(deps, quoteId, (quote, now) => Quotes.chooseMovers(quote, count, now));
}

// ---- processes across the two aggregates --------------------------------------------------------

// Confirm: decide the quote's event first (pure, nothing written), reserve the trucks on the day,
// then lock the quote. If locking fails, give the trucks back (compensation).
// A failure halfway leaves a truck held too long, never a confirmed quote without a truck.
export function confirmQuote(deps: Deps, quoteId: string): Result<{ priceCents: number }> {
    const loaded = loadQuote(deps, quoteId);
    if (!loaded.ok) return loaded;
    const now = deps.now();

    const decided = Quotes.confirmQuote(loaded.value.state, deps.reference.rates, now);
    if (!decided.ok) return decided;
    const [confirmed] = decided.value;

    const fleet = deps.reference.fleetSize(confirmed.moveDate);
    const reserved = onDay(deps, confirmed.moveDate, (day, at) => TruckDays.reserveTrucks(day, quoteId, confirmed.trucks, fleet, at), now);
    if (!reserved.ok) return reserved;

    const locked = deps.quotes.append(quoteStream(quoteId), loaded.value.version, decided.value);
    if (!locked.ok) {
        onDay(deps, confirmed.moveDate, (day, at) => TruckDays.releaseTrucks(day, quoteId, at), now);
        const reason = locked.error === CONFLICT ? 'the quote changed while confirming; review it and confirm again' : locked.error;
        return { ok: false, error: reason };
    }
    return { ok: true, value: { priceCents: confirmed.priceCents } };
}

// Cancel runs the other way: the 7-day rule lives in the quote, so cancel it first, then release.
// If the release fails, the trucks stay held: unavailable, never double-booked.
export function cancelQuote(deps: Deps, quoteId: string): Result<void> {
    const loaded = loadQuote(deps, quoteId);
    if (!loaded.ok) return loaded;
    const now = deps.now();

    const decided = Quotes.cancelQuote(loaded.value.state, now);
    if (!decided.ok) return decided;
    const [cancelled] = decided.value;

    const appended = deps.quotes.append(quoteStream(quoteId), loaded.value.version, decided.value);
    if (!appended.ok) {
        return appended.error === CONFLICT ? { ok: false, error: 'the quote changed in another window; reload and try again' } : appended;
    }

    const released = onDay(deps, cancelled.moveDate, (day, at) => TruckDays.releaseTrucks(day, quoteId, at), now);
    if (!released.ok) {
        return { ok: false, error: `the quote is cancelled, but its trucks on ${cancelled.moveDate} were not released: ${released.error}` };
    }
    return { ok: true, value: undefined };
}
