export type Slot = { slotId: string; start: string; end: string; resource: string };
export type Booking = { bookingId: string; slotId: string; name: string; contact: string };

export type BookResult = { ok: true; bookingId: string } | { ok: false; error: "SLOT_TAKEN" | "NOT_FOUND" };
export type CancelResult = { ok: true } | { ok: false; error: "NOT_FOUND" };

/** Storage port. Async so a database-backed implementation can replace it without changing callers. */
export interface AppointmentStore {
  listAvailable(date: string, resource?: string): Promise<Slot[]>;
  book(slotId: string, name: string, contact: string): Promise<BookResult>;
  cancel(bookingId: string): Promise<CancelResult>;
}

export class InMemoryStore implements AppointmentStore {
  private readonly slots = new Map<string, Slot>();
  private readonly bookings = new Map<string, Booking>();
  private readonly bookedSlots = new Set<string>();
  private nextId = 1;

  constructor(slots: Slot[]) {
    for (const slot of slots) this.slots.set(slot.slotId, slot);
  }

  async listAvailable(date: string, resource?: string): Promise<Slot[]> {
    return [...this.slots.values()].filter(
      (s) =>
        s.start.startsWith(date) &&
        (resource === undefined || s.resource === resource) &&
        !this.bookedSlots.has(s.slotId),
    );
  }

  async book(slotId: string, name: string, contact: string): Promise<BookResult> {
    if (!this.slots.has(slotId)) return { ok: false, error: "NOT_FOUND" };
    if (this.bookedSlots.has(slotId)) return { ok: false, error: "SLOT_TAKEN" };
    const bookingId = `bk_${this.nextId++}`;
    this.bookings.set(bookingId, { bookingId, slotId, name, contact });
    this.bookedSlots.add(slotId);
    return { ok: true, bookingId };
  }

  async cancel(bookingId: string): Promise<CancelResult> {
    const booking = this.bookings.get(bookingId);
    if (!booking) return { ok: false, error: "NOT_FOUND" };
    this.bookings.delete(bookingId);
    this.bookedSlots.delete(booking.slotId);
    return { ok: true };
  }

  get bookingCount(): number {
    return this.bookings.size;
  }
}

/** Hourly slots for each date and resource, e.g. seedSlots(["2026-11-02"], ["room-a"], [9, 10]). Times are UTC. */
export function seedSlots(dates: string[], resources: string[], hours: number[]): Slot[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return dates.flatMap((date) =>
    resources.flatMap((resource) =>
      hours.map((h) => ({
        slotId: `${resource}-${date}T${pad(h)}`,
        start: `${date}T${pad(h)}:00:00Z`,
        end: `${date}T${pad(h + 1)}:00:00Z`,
        resource,
      })),
    ),
  );
}
