// Reference data: facts the business was handed, not facts it produced.
// The domain knows their shape. Where they come from is a plug (constants for now).

export interface CatalogItem {
    name: string;
    defaultWeightKg: number;
}

export interface RateCard {
    baseFeeCents: number;          // every move
    perTruckCents: number;         // each truck, once per move
    perKmPerTruckCents: number;    // each truck, per km of the route
    perMoverHourCents: number;     // each mover, per hour
    kgPerMoverHour: number;        // how much one mover carries in an hour
    kgPerSuggestedMover: number;   // the app suggests one mover per this many kg
    minMovers: number;
    minHours: number;
    truckCapacityKg: number;
}

export interface ReferenceData {
    catalog: CatalogItem[];
    rates: RateCard;
    fleetSize(date: string): number;   // trucks the company has on that day
}
