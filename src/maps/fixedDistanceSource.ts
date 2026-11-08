// infrastructure: the simplest plug for the distance socket. Every route is the same length,
// except addresses it is told it cannot find. For tests: fast, offline, predictable.

import { DistanceSource } from '../domain/distanceSource';
import { Result } from '../domain/result';

export class FixedDistanceSource implements DistanceSource {
    constructor(private readonly km: number, private readonly unknownAddresses: string[] = []) {}

    async distanceKm(pickup: string, delivery: string): Promise<Result<number>> {
        for (const address of [pickup, delivery]) {
            if (this.unknownAddresses.includes(address)) return { ok: false, error: `the maps service could not find "${address}"` };
        }
        return { ok: true, value: this.km };
    }
}
