/** Squarified treemap layout (Bruls, Huizing & van Wijk). Pure function, no DOM. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Placed<T> extends Rect {
  item: T;
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

export function squarify<T>(items: T[], value: (t: T) => number, box: Rect): Placed<T>[] {
  const total = items.reduce((s, t) => s + Math.max(0, value(t)), 0);
  if (!total || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const nodes = items
    .map((item) => ({ item, area: Math.max(0, value(item)) * scale }))
    .filter((n) => n.area > 0)
    .sort((a, b) => b.area - a.area);

  const out: Placed<T>[] = [];
  let { x, y, w, h } = box;
  let i = 0;
  while (i < nodes.length) {
    const side = Math.min(w, h);
    const row = [nodes[i]!];
    i++;
    while (i < nodes.length) {
      const cur = row.map((n) => n.area);
      const next = [...cur, nodes[i]!.area];
      if (worst(next, side) > worst(cur, side)) break;
      row.push(nodes[i]!);
      i++;
    }
    const rowArea = row.reduce((s, n) => s + n.area, 0);
    if (w >= h) {
      // lay the row out as a column on the left
      const colW = rowArea / h;
      let cy = y;
      for (const n of row) {
        const nh = n.area / colW;
        out.push({ item: n.item, x, y: cy, w: colW, h: nh });
        cy += nh;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = rowArea / w;
      let cx = x;
      for (const n of row) {
        const nw = n.area / rowH;
        out.push({ item: n.item, x: cx, y, w: nw, h: rowH });
        cx += nw;
      }
      y += rowH;
      h -= rowH;
    }
  }
  return out;
}
