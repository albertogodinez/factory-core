export interface InventoryItem<Kind extends string = string> {
  id: string;
  kind: Kind;
  source: string;
}

export type InventoryResult<Kind extends string = string> = { items: InventoryItem<Kind>[] } | { skipped: string };
