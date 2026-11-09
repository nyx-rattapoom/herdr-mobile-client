import { isObj, type CoreTerminal } from './types';

/**
 * Read-only view of the desktop `herdr-app` document.
 *
 * The phone never writes layout documents in Core v1, so unknown blocks and
 * fields are simply preserved on the desktop side; here they are ignored.
 */

export type CoreLayoutTab = { id: string; name: string; terminals: string[] };
export type CoreLayoutSpace = { id: string; name: string; folder: string; tabs: CoreLayoutTab[] };
export type CoreLayout = { spaces: CoreLayoutSpace[]; placed: Set<string> };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function contentTerminals(content: unknown, out: Set<string>): void {
  if (!isObj(content)) return;
  if (typeof content.terminal === 'string' && content.terminal) out.add(content.terminal);
  // `agent`/`tab` contents address an agent or a tab, not a terminal record.
}

function walkNode(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 64 || !isObj(node)) return;
  const type = text(node.type).toLowerCase();
  if (type === 'block') contentTerminals(node.content, out);
  if (Array.isArray(node.children)) for (const child of node.children) walkNode(child, out, depth + 1);
  if (Array.isArray(node.floating)) {
    for (const f of node.floating) {
      if (isObj(f)) contentTerminals(f.content, out);
    }
  }
}

/** `null` when the document has never been written (or is not a layout). */
export function parseLayout(value: unknown): CoreLayout | null {
  if (value === null || value === undefined) return null;
  if (!isObj(value)) return { spaces: [], placed: new Set() };
  const spaces: CoreLayoutSpace[] = [];
  const placed = new Set<string>();
  const rawSpaces = Array.isArray(value.spaces) ? value.spaces : [];
  for (const s of rawSpaces) {
    if (!isObj(s)) continue;
    const tabs: CoreLayoutTab[] = [];
    const rawTabs = Array.isArray(s.tabs) ? s.tabs : [];
    for (const t of rawTabs) {
      if (!isObj(t)) continue;
      const terminals = new Set<string>();
      walkNode(t.root, terminals);
      for (const address of terminals) placed.add(address);
      tabs.push({ id: text(t.id), name: text(t.name), terminals: [...terminals] });
    }
    spaces.push({ id: text(s.id), name: text(s.name), folder: text(s.folder), tabs });
  }
  return { spaces, placed };
}

export function unplacedTerminals(layout: CoreLayout | null, terminals: CoreTerminal[]): CoreTerminal[] {
  if (!layout) return terminals;
  return terminals.filter((t) => !layout.placed.has(t.address));
}
