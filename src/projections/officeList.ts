// read side: the office's list of quotes. Pure: every quote event in, one row per quote out.

import { estimate, foldQuote, QuoteEvent, QuoteStatus, totalWeightKg } from '../domain/quote';
import { RateCard } from '../domain/reference';
import { Stored } from '../domain/result';

export interface QuoteRow {
    quoteId: string;
    status: QuoteStatus;
    startedAt: string;
    moveDate: string | undefined;
    items: number;
    totalWeightKg: number;
    priceCents: number;
    priceIsFinal: boolean;   // confirmed price, not an estimate
}

export function officeList(events: Stored<QuoteEvent>[], rates: RateCard): QuoteRow[] {
    const byQuote = new Map<string, Stored<QuoteEvent>[]>();
    for (const event of events) byQuote.set(event.quoteId, [...(byQuote.get(event.quoteId) ?? []), event]);

    const rows: QuoteRow[] = [];
    for (const [quoteId, stream] of byQuote) {
        const folded = foldQuote(stream);
        if (!folded.ok) continue;
        const quote = folded.value;
        rows.push({
            quoteId,
            status: quote.status,
            startedAt: stream[0].at,
            moveDate: quote.moveDate,
            items: quote.lines.reduce((n, line) => n + line.quantity, 0),
            totalWeightKg: totalWeightKg(quote),
            priceCents: quote.priceCents ?? estimate(quote, rates).breakdown.totalCents,
            priceIsFinal: quote.priceCents !== undefined,
        });
    }
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
