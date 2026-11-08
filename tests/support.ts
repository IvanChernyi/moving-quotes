// Shared test fixtures: small round numbers so the arithmetic in the tests can be checked by hand.

import { CatalogItem, RateCard, ReferenceData } from '../src/domain/reference';
import { Now } from '../src/domain/time';

export const testCatalog: CatalogItem[] = [
    { name: 'Sofa', defaultWeightKg: 60 },
    { name: 'Box', defaultWeightKg: 15 },
    { name: 'Piano', defaultWeightKg: 250 },
];

export const testRates: RateCard = {
    baseFeeCents: 10_000,
    perTruckCents: 20_000,
    perKmPerTruckCents: 100,
    perMoverHourCents: 5_000,
    kgPerMoverHour: 100,
    kgPerSuggestedMover: 300,
    minMovers: 2,
    minHours: 2,
    truckCapacityKg: 1_000,
};

export const testReference: ReferenceData = { catalog: testCatalog, rates: testRates, fleetSize: () => 2 };

export function nowOn(today: string): Now {
    return { at: `${today}T12:00:00.000Z`, today };
}
