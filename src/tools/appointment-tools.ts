import * as z from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import type { AppointmentStore } from "./store.js";

export const listAvailableSlotsInput = z.object({
  date: z.iso.date().describe("Day to search, YYYY-MM-DD"),
  resource: z.string().min(1).max(40).optional().describe("Optional resource id, e.g. room-a"),
});

export const bookSlotInput = z.object({
  slotId: z.string().min(1).max(80).describe("slotId returned by list_available_slots"),
  name: z.string().trim().min(1).max(80).describe("Name of the person booking"),
  contact: z.string().trim().min(3).max(120).describe("Phone number or email for confirmation"),
});

export const cancelBookingInput = z.object({
  bookingId: z.string().min(1).max(40).describe("bookingId returned by book_slot"),
});

export function appointmentTools(store: AppointmentStore): ToolDefinition[] {
  return [
    defineTool({
      name: "list_available_slots",
      description: "List free one-hour slots for a date, optionally filtered by resource.",
      input: listAvailableSlotsInput,
      handler: async ({ date, resource }) => ({ slots: await store.listAvailable(date, resource) }),
    }),
    defineTool({
      name: "book_slot",
      description: "Book a free slot. Confirm the slot, name and contact with the caller first.",
      input: bookSlotInput,
      handler: ({ slotId, name, contact }) => store.book(slotId, name, contact),
    }),
    defineTool({
      name: "cancel_booking",
      description: "Cancel an existing booking by its id.",
      input: cancelBookingInput,
      handler: ({ bookingId }) => store.cancel(bookingId),
    }),
  ];
}
