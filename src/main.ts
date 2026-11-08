// composition root: the only place that names a file on disk, a plug, the clock, the id generator
// or an environment variable. Everything else depends on interfaces.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { Deps } from './commands/quotes';
import { QuoteEvent, QuoteEventSchema } from './domain/quote';
import { TruckDayEvent, TruckDayEventSchema } from './domain/truckDay';
import { createApp } from './http/app';
import { FakeMapsDistanceSource } from './maps/fakeMapsDistanceSource';
import { referenceData } from './reference/constants';
import { SqlEventStore } from './storage/sqlEventStore';

// The company's calendar date right now. en-CA formats dates as YYYY-MM-DD.
function todayIn(timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function main(): void {
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'moving.sqlite'));

    const quotes = new SqlEventStore<QuoteEvent>(db, 'quote_events', QuoteEventSchema);
    const days = new SqlEventStore<TruckDayEvent>(db, 'truckday_events', TruckDayEventSchema);
    const timeZone = process.env.COMPANY_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    const deps: Deps = {
        quotes,
        days,
        distances: new FakeMapsDistanceSource(),   // swap for a real maps plug later; nothing else changes
        reference: referenceData,
        newId: () => randomUUID(),
        now: () => ({ at: new Date().toISOString(), today: todayIn(timeZone) }),
    };

    const app = createApp(deps, { quotes, days });
    app.use(express.static(path.join(__dirname, '..', 'public')));

    const port = Number(process.env.PORT ?? 3100);
    app.listen(port, () => console.log(`moving-quote at http://localhost:${port} (maps: fake · time zone: ${timeZone})`));
}

main();

// npm run dev
