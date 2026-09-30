/** Format integer paisa as PKR, e.g. 83000 -> "PKR 830.00". */
export function formatPkr(paisa: number | null | undefined): string {
  if (paisa == null || Number.isNaN(Number(paisa))) return '—';
  return `PKR ${(Number(paisa) / 100).toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact date-time in Asia/Karachi. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-PK', {
      timeZone: 'Asia/Karachi',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(iso);
  }
}
