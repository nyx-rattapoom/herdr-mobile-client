export type SlashCommand = { name: string; description: string };

const LEAD = /^[\s│┃║|▌▐▕❯›»>▶▸►•*·]*/;
const TRAIL = /[\s│┃║|▌▐▕]*$/;
const NAME = '\\/[A-Za-z0-9](?:[\\w:.-]*[A-Za-z0-9])?';
const ROW = new RegExp(`^(${NAME})(?:\\s{2,}|\\t+|\\s+[-–—]\\s+|:\\s+)(\\S.*)$`);
const NAME_ONLY = new RegExp(`^(${NAME})$`);

export function parseSlashMenu(text: string): SlashCommand[] {
  const withDesc: SlashCommand[] = [];
  const bare: SlashCommand[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(LEAD, '').replace(TRAIL, '');
    const m = ROW.exec(line);
    if (m) {
      withDesc.push({ name: m[1], description: m[2].replace(/\s{2,}/g, ' ').trim() });
      continue;
    }
    const n = NAME_ONLY.exec(line);
    if (n) bare.push({ name: n[1], description: '' });
  }
  return dedupe(withDesc.length ? withDesc : bare.length >= 2 ? bare : []);
}

function dedupe(list: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

export function mergeCommands(known: SlashCommand[], more: SlashCommand[]): SlashCommand[] {
  return dedupe([...known, ...more]);
}

export function hasLoneSlash(text: string): boolean {
  return text.split('\n').some((raw) => raw.replace(LEAD, '').replace(TRAIL, '') === '/');
}

type Query = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SlashMenu {
  commands: SlashCommand[] = [];
  complete = false;
  private open_ = false;
  private cursor = 0;
  private top = '';

  constructor(
    private readonly query: Query,
    private readonly paneId: string,
    private readonly sleep: Sleep = defaultSleep,
    private readonly timeoutMs = 3000,
    private readonly pollMs = 250,
  ) {}

  get isOpen() {
    return this.open_;
  }

  private async read(): Promise<string> {
    const res = await this.query<{ read?: { text?: string } }>('pane.read', {
      pane_id: this.paneId,
      source: 'visible',
      format: 'text',
    });
    return res?.read?.text ?? '';
  }

  private async poll(): Promise<SlashCommand[]> {
    for (let waited = 0; ; waited += this.pollMs) {
      const found = parseSlashMenu(await this.read());
      if (found.length || waited >= this.timeoutMs) return found;
      await this.sleep(this.pollMs);
    }
  }

  async open(): Promise<SlashCommand[]> {
    if (!hasLoneSlash(await this.read())) await this.query('pane.send_text', { pane_id: this.paneId, text: '/' });
    this.open_ = true;
    this.commands = await this.poll();
    this.top = this.commands[0]?.name ?? '';
    return this.commands;
  }

  private async down(n: number) {
    if (n === 0) return;
    await this.query('pane.send_keys', { pane_id: this.paneId, keys: Array(Math.abs(n)).fill(n > 0 ? 'down' : 'up') });
    this.cursor += n;
  }

  private async nextPage(): Promise<SlashCommand[]> {
    let page: SlashCommand[] = [];
    for (let tries = 0; tries < 4; tries++) {
      await this.sleep(this.pollMs);
      page = parseSlashMenu(await this.read());
      if (page.length && page[0].name !== this.top) break;
    }
    return page;
  }

  private async finishAfterWrap(step: number, first: string) {
    await this.down(-step);
    this.top = '';
    for (let i = 0; i < step; i++) {
      await this.down(1);
      const page = await this.nextPage();
      if (page[0]?.name === first) break;
      this.commands = mergeCommands(this.commands, page);
      this.top = page[0]?.name ?? this.top;
    }
    this.complete = true;
  }

  async more(rows = 10, step = 5): Promise<SlashCommand[]> {
    if (this.complete || !this.commands.length) return this.commands;
    const first = this.commands[0].name;
    const target = this.commands.length + rows;
    await this.down(this.commands.length - 1 - this.cursor);
    while (this.commands.length < target) {
      await this.down(step);
      const page = await this.nextPage();
      if (page[0]?.name === first) {
        await this.finishAfterWrap(step, first);
        break;
      }
      const before = this.commands.length;
      this.commands = mergeCommands(this.commands, page);
      if (this.commands.length === before) break;
      this.top = page[0]?.name ?? this.top;
    }
    return this.commands;
  }

  async choose(name: string): Promise<void> {
    await this.query('pane.send_text', { pane_id: this.paneId, text: name.replace(/^\//, '') });
    await this.sleep(this.pollMs);
    await this.query('pane.send_keys', { pane_id: this.paneId, keys: ['enter'] });
    this.open_ = false;
  }

  async cancel(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    await this.query('pane.send_keys', { pane_id: this.paneId, keys: ['esc'] });
    await this.sleep(this.pollMs);
    if (hasLoneSlash(await this.read())) {
      await this.query('pane.send_keys', { pane_id: this.paneId, keys: ['backspace'] });
    }
  }
}
