export type Box = { id: string; x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Places tiles so none overlap. The tile being moved keeps its spot, and anything in its way moves down just far enough. */
export function arrange<T extends Box>(tiles: T[], activeId?: string): T[] {
  const active = tiles.find((t) => t.id === activeId), rest = tiles.filter((t) => t.id !== activeId).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: T[] = active ? [active] : [];
  for (const t of rest) {
    // While a tile moves, the others also close any gap above them
    const next = { ...t, y: active ? 0 : t.y };
    for (let clash = placed.find((p) => hit(p, next)); clash; clash = placed.find((p) => hit(p, next))) next.y = clash.y + clash.h;
    placed.push(next);
  }
  return placed;
}
