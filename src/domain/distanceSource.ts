// Distances come from outside. The domain names the socket; a plug fetches them.
// You do not own distances.

import { Result } from './result';

export interface DistanceSource {
    distanceKm(pickup: string, delivery: string): Promise<Result<number>>;   // async: it is the network. Failures are values.
}
