/** One mailbox view owns a generation. Late requests cannot replace a newer view. */
export class PageSession<T extends { id: string }> {
 private generation = 0;
 private rows: T[] = [];
 reset(): number { this.rows = []; return ++this.generation; }
 current(generation: number): boolean { return generation === this.generation; }
 accept(generation: number, items: T[], append: boolean): T[] | null {
  if (!this.current(generation)) return null;
  const byId = new Map((append ? this.rows : []).map(row => [row.id, row]));
  for (const row of items) byId.set(row.id, row);
  this.rows = [...byId.values()];
  return this.rows;
 }
}
