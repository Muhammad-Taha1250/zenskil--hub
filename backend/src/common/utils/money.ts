// Money helpers. Amounts are stored as integer paisa everywhere; these
// helpers only format for display. Never use floats for money math.

export function formatPkr(paisa: number): string {
  if (!Number.isInteger(paisa)) throw new Error(`Non-integer paisa value: ${paisa}`);
  const rupees = paisa / 100;
  return `PKR ${rupees.toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;
}

/** Percent discount in paisa, rounded down (customer-favourable). */
export function percentDiscountPaisa(subtotalPaisa: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new Error(`Invalid percent: ${percent}`);
  return Math.floor((subtotalPaisa * percent) / 100);
}

export function addPaisa(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error('Paisa overflow');
  return sum;
}

export function subtractPaisa(a: number, b: number): number {
  const diff = a - b;
  if (!Number.isSafeInteger(diff)) throw new Error('Paisa overflow');
  if (diff < 0) throw new Error('Paisa underflow: result would be negative');
  return diff;
}
