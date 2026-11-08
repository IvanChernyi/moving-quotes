// read side: what the calculator page shows for one quote. Pure: events in, view out.

import {
    CANCEL_NOTICE_DAYS, capacityShortKg, Estimate, estimate, foldQuote, Quote, QuoteEvent,
    suggestedMovers, suggestedTrucks, totalWeightKg,
} from '../domain/quote';
import { RateCard } from '../domain/reference';
import { Result, Stored } from '../domain/result';
import { addDays } from '../domain/time';

export interface QuoteView {
    quote: Quote;
    totalWeightKg: number;
    truckCapacityKg: number;
    capacityShortKg: number;
    suggestedTrucks: number;
    suggestedMovers: number;
    estimate: Estimate;
    cancellableUntil: string | undefined;   // the last date a confirmed quote can still be cancelled
    events: Stored<QuoteEvent>[];
}

export function quoteView(events: Stored<QuoteEvent>[], rates: RateCard): Result<QuoteView> {
    const folded = foldQuote(events);
    if (!folded.ok) return folded;
    const quote = folded.value;
    return {
        ok: true,
        value: {
            quote,
            totalWeightKg: totalWeightKg(quote),
            truckCapacityKg: rates.truckCapacityKg,
            capacityShortKg: capacityShortKg(quote, rates),
            suggestedTrucks: suggestedTrucks(quote, rates),
            suggestedMovers: suggestedMovers(quote, rates),
            estimate: estimate(quote, rates),
            cancellableUntil: quote.status === 'confirmed' && quote.moveDate ? addDays(quote.moveDate, -(CANCEL_NOTICE_DAYS + 1)) : undefined,
            events,
        },
    };
}
