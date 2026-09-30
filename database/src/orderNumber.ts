// Deterministic order-number generator: ZSH-YYYYMMDD-XXXXX
// The per-day sequence row is incremented atomically (single UPSERT
// statement), so concurrent callers serialize on the row lock and sequence
// values are never duplicated or skipped within a day. The day boundary uses
// Asia/Karachi, the business timezone.

import type { PrismaClient } from "@prisma/client";

type Db = Pick<PrismaClient, "orderSequence">;

const TIME_ZONE = "Asia/Karachi";

export function karachiDayString(at: Date = new Date()): string {
  // en-CA => YYYY-MM-DD
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts.replaceAll("-", ""); // YYYYMMDD
}

export function formatOrderNumber(day: string, seq: number): string {
  if (!/^\d{8}$/.test(day)) throw new Error(`Invalid day string: ${day}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > 99999) {
    throw new Error(`Sequence out of range (1-99999): ${seq}`);
  }
  return `ZSH-${day}-${String(seq).padStart(5, "0")}`;
}

export function isValidOrderNumber(value: string): boolean {
  return /^ZSH-\d{8}-\d{5}$/.test(value);
}

/** Reserve the next order number for today (Asia/Karachi). Safe to call
 *  concurrently; each caller gets a unique number. */
export async function generateOrderNumber(
  prisma: Db,
  at: Date = new Date(),
): Promise<string> {
  const day = karachiDayString(at);
  const row = await prisma.orderSequence.upsert({
    where: { day },
    create: { day, counter: 1 },
    update: { counter: { increment: 1 } },
  });
  return formatOrderNumber(day, row.counter);
}
