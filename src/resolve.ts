export function isNumericRef(key: string): boolean {
  return /^[0-9]+$/.test(key);
}

export function parseBareRefs(stdout: string): number[] {
  const refs: number[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "-1" || !isNumericRef(line)) continue;
    refs.push(Number(line));
  }
  return refs;
}

export function nextRef(refs: number[]): number {
  let max = 0;
  for (const ref of refs) if (ref > max) max = ref;
  return max + 1;
}