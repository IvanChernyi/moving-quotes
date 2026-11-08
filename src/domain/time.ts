// Time as the domain sees it: handed in, never read from a clock.

// "now" for a verb. The app layer's clock produces both parts.
export interface Now {
    at: string;      // ISO-8601 UTC: when it happened, stamped on events
    today: string;   // YYYY-MM-DD in the company's time zone: what date rules compare against
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

// A real calendar date in YYYY-MM-DD form. '2026-02-30' is refused.
export function isDate(value: string): boolean {
    if (!DATE.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const back = new Date(toUtcMs(value));
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

// Whole calendar days from one date to another: daysBetween('2026-11-08', '2026-11-15') is 7.
export function daysBetween(from: string, to: string): number {
    return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
    return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}
