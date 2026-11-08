// infrastructure: the reference data plug. Constants for now; a table or an admin page later.
// The domain only knows the shapes in domain/reference.ts.

import { CatalogItem, RateCard, ReferenceData } from '../domain/reference';

export const CATALOG: CatalogItem[] = [
    { name: 'Sofa', defaultWeightKg: 60 },
    { name: 'Armchair', defaultWeightKg: 25 },
    { name: 'Bed frame', defaultWeightKg: 45 },
    { name: 'Mattress', defaultWeightKg: 30 },
    { name: 'Wardrobe', defaultWeightKg: 90 },
    { name: 'Dresser', defaultWeightKg: 50 },
    { name: 'Dining table', defaultWeightKg: 40 },
    { name: 'Chair', defaultWeightKg: 7 },
    { name: 'Desk', defaultWeightKg: 35 },
    { name: 'Bookshelf', defaultWeightKg: 30 },
    { name: 'Fridge', defaultWeightKg: 80 },
    { name: 'Washing machine', defaultWeightKg: 75 },
    { name: 'Piano', defaultWeightKg: 250 },
    { name: 'TV', defaultWeightKg: 15 },
    { name: 'Box', defaultWeightKg: 15 },
];

export const RATES: RateCard = {
    baseFeeCents: 9_900,
    perTruckCents: 15_000,
    perKmPerTruckCents: 200,
    perMoverHourCents: 4_500,
    kgPerMoverHour: 150,
    kgPerSuggestedMover: 400,
    minMovers: 2,
    minHours: 2,
    truckCapacityKg: 3_000,
};

export const referenceData: ReferenceData = {
    catalog: CATALOG,
    rates: RATES,
    fleetSize: (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? 2 : 4),   // fewer crews on Sundays
};
