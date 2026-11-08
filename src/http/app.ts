// http edge: translate the request, delegate, answer. No business rules here.
// zod checks every body: request data comes from outside the world.

import express from 'express';
import { z } from 'zod';
import * as Commands from '../commands/quotes';
import { EventFeed } from '../domain/eventStore';
import { QuoteEvent } from '../domain/quote';
import { Result } from '../domain/result';
import { isDate } from '../domain/time';
import { TruckDayEvent } from '../domain/truckDay';
import { calendar } from '../projections/calendar';
import { officeList } from '../projections/officeList';
import { quoteView } from '../projections/quoteView';

const ItemBody = z.object({ item: z.string().min(1), quantity: z.number().int().positive(), weightKg: z.number().int().positive().optional() });
const WeightBody = z.object({ weightKg: z.number().int().positive() });
const AddressesBody = z.object({ pickup: z.string(), delivery: z.string() });
const DateBody = z.object({ date: z.string() });
const CountBody = z.object({ count: z.number().int().positive() });
const LineParam = z.coerce.number().int().positive();
const DaysParam = z.coerce.number().int().min(1).max(60);

export interface Feeds {
    quotes: EventFeed<QuoteEvent>;
    days: EventFeed<TruckDayEvent>;
}

// The one translator from a Result to an HTTP answer. A throw is a bug, not a business failure.
async function reply(res: express.Response, work: Result<unknown> | Promise<Result<unknown>>): Promise<void> {
    try {
        const result = await work;
        if (result.ok) res.status(200).json(result.value ?? {});
        else res.status(400).json({ error: result.error });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'internal error' });
    }
}

const invalid = (error: string): Result<never> => ({ ok: false, error });

export function createApp(deps: Commands.Deps, feeds: Feeds): express.Express {
    const app = express();
    app.use(express.json());

    // ---- write side → commands ----------------------------------------------------------------

    app.post('/api/quotes', (_req, res) => {
        reply(res, Commands.startQuote(deps));
    });

    app.post('/api/quotes/:id/items', (req, res) => {
        const body = ItemBody.safeParse(req.body);
        if (!body.success) return reply(res, invalid('item, a whole quantity and an optional whole weight are needed'));
        reply(res, Commands.addItem(deps, req.params.id, { item: body.data.item, quantity: body.data.quantity, weightKg: body.data.weightKg }));
    });

    app.post('/api/quotes/:id/items/:lineNo/weight', (req, res) => {
        const lineNo = LineParam.safeParse(req.params.lineNo);
        const body = WeightBody.safeParse(req.body);
        if (!lineNo.success || !body.success) return reply(res, invalid('a line number and a whole weight in kg are needed'));
        reply(res, Commands.changeItemWeight(deps, req.params.id, lineNo.data, body.data.weightKg));
    });

    app.post('/api/quotes/:id/items/:lineNo/remove', (req, res) => {
        const lineNo = LineParam.safeParse(req.params.lineNo);
        if (!lineNo.success) return reply(res, invalid('a line number is needed'));
        reply(res, Commands.removeItem(deps, req.params.id, lineNo.data));
    });

    app.post('/api/quotes/:id/addresses', (req, res) => {
        const body = AddressesBody.safeParse(req.body);
        if (!body.success) return reply(res, invalid('pickup and delivery are needed'));
        reply(res, Commands.chooseAddresses(deps, req.params.id, body.data));
    });

    app.post('/api/quotes/:id/move-date', (req, res) => {
        const body = DateBody.safeParse(req.body);
        if (!body.success) return reply(res, invalid('a date is needed'));
        reply(res, Commands.chooseMoveDate(deps, req.params.id, body.data.date));
    });

    app.post('/api/quotes/:id/trucks', (req, res) => {
        const body = CountBody.safeParse(req.body);
        if (!body.success) return reply(res, invalid('a whole number of trucks is needed'));
        reply(res, Commands.chooseTrucks(deps, req.params.id, body.data.count));
    });

    app.post('/api/quotes/:id/movers', (req, res) => {
        const body = CountBody.safeParse(req.body);
        if (!body.success) return reply(res, invalid('a whole number of movers is needed'));
        reply(res, Commands.chooseMovers(deps, req.params.id, body.data.count));
    });

    app.post('/api/quotes/:id/confirm', (req, res) => {
        reply(res, Commands.confirmQuote(deps, req.params.id));
    });

    app.post('/api/quotes/:id/cancel', (req, res) => {
        reply(res, Commands.cancelQuote(deps, req.params.id));
    });

    // ---- read side → projections ---------------------------------------------------------------

    app.get('/api/quotes', (_req, res) => {
        res.json(officeList(feeds.quotes.readAll(), deps.reference.rates));
    });

    app.get('/api/quotes/:id', (req, res) => {
        const events = deps.quotes.read(Commands.quoteStream(req.params.id));
        if (events.length === 0) return res.status(404).json({ error: `there is no quote ${req.params.id}` });
        reply(res, quoteView(events, deps.reference.rates));
    });

    app.get('/api/calendar', (req, res) => {
        const from = String(req.query.from ?? deps.now().today);
        const days = DaysParam.safeParse(req.query.days ?? 28);
        if (!isDate(from) || !days.success) return reply(res, invalid('from must be a date and days between 1 and 60'));
        res.json(calendar(feeds.days.readAll(), from, days.data, deps.reference.fleetSize));
    });

    app.get('/api/catalog', (_req, res) => {
        res.json({ items: deps.reference.catalog, today: deps.now().today });
    });

    return app;
}
