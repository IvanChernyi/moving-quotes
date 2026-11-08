// infrastructure: a stand-in for a real maps API, until there is one.
// It behaves like one at the socket: async, a little latency, unknown addresses fail as values.
// The distances are made up but stable: the same two addresses always give the same km, either way round.
// Swapping in a real maps API means writing a new plug; nothing else changes.

import { DistanceSource } from '../domain/distanceSource';
import { Result } from '../domain/result';

export class FakeMapsDistanceSource implements DistanceSource {
    constructor(private readonly latencyMs: number = 150) {}

    async distanceKm(pickup: string, delivery: string): Promise<Result<number>> {
        await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

        const from = normalise(pickup);
        const to = normalise(delivery);
        if (from.length < 5) return { ok: false, error: `the maps service could not find "${pickup}"` };
        if (to.length < 5) return { ok: false, error: `the maps service could not find "${delivery}"` };
        if (from === to) return { ok: false, error: 'pickup and delivery are the same address' };

        const [first, second] = [from, to].sort();
        return { ok: true, value: 3 + (hash(`${first}|${second}`) % 398) };   // 3 to 400 km
    }
}

function normalise(address: string): string {
    return address.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hash(text: string): number {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
    return h;
}
