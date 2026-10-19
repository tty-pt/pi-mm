export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface JointWindow {
  a: string;
  b: string;
}

export function levelWindow(level: number, now: Date): JointWindow | null {
  if (level === 0) return null;
  if (level === 1) {
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { a: toISODate(a), b: toISODate(b) };
  }
  if (level === 2) {
    const a = new Date(now.getFullYear(), now.getMonth(), 1);
    const b = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { a: toISODate(a), b: toISODate(b) };
  }
  return null;
}