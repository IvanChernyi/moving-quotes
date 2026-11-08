// read side: the availability calendar. Pure: every TruckDay event in, free trucks per date out.

import { Stored } from '../domain/result';
import { addDays } from '../domain/time';
import { foldTruckDay, reservedTrucks, TruckDayEvent } from '../domain/truckDay';

export interface CalendarDay {
    date: string;
    fleet: number;
    reserved: number;
    free: number;
}

export function calendar(events: Stored<TruckDayEvent>[], from: string, days: number, fleetSize: (date: string) => number): CalendarDay[] {
    const byDate = new Map<string, Stored<TruckDayEvent>[]>();
    for (const event of events) byDate.set(event.date, [...(byDate.get(event.date) ?? []), event]);

    const result: CalendarDay[] = [];
    for (let i = 0; i < days; i++) {
        const date = addDays(from, i);
        const day = foldTruckDay(byDate.get(date) ?? []);
        const reserved = day.ok ? reservedTrucks(day.value) : 0;   // no events: nobody booked that day
        const fleet = fleetSize(date);
        result.push({ date, fleet, reserved, free: fleet - reserved });
    }
    return result;
}
