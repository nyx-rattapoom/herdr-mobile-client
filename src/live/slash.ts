export type SlashCommand = { name: string; description: string };

/** Box borders, selection markers and bullets that agents draw around menu rows. */
const LEAD = /^[\s│┃║|▌▐▕❯›»>▶▸►•*·]*/;
const TRAIL = /[\s│┃║|▌▐▕]*$/;
/** A command name: `/` then letters, digits and `_ : . -`, ending on a letter or digit. */
const NAME = '\\/[A-Za-z0-9](?:[\\w:.-]*[A-Za-z0-9])?';
/** `/name` then a column gap (2+ spaces, a tab, a spaced dash, or `: `) and a description. */
const ROW = new RegExp(`^(${NAME})(?:\\s{2,}|\\t+|\\s+[-–—]\\s+|:\\s+)(\\S.*)$`);
/** A row with only a name, as in menus without descriptions. */
const NAME_ONLY = new RegExp(`^(${NAME})$`);

/**
 * Slash commands visible in an agent's screen (plain text from pane.read). Agent-agnostic: it
 * looks for rows that start with `/name`, optionally inside box borders or after a selection
 * marker, followed by a description. Paths such as `/home/me` don't match: a name stops at the
 * second `/` and must be followed by a gap. Name-only rows count only when there are several.
 */
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

/** Adds newly seen commands after the known ones, keeping the first description seen. */
export function mergeCommands(known: SlashCommand[], more: SlashCommand[]): SlashCommand[] {
  return dedupe([...known, ...more]);
}

/** True when the screen still shows a prompt line holding only the `/` we typed. */
export function hasLoneSlash(text: string): boolean {
  return text.split('\n').some((raw) => raw.replace(LEAD, '').replace(TRAIL, '') === '/');
}

type Query = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads an agent's slash-command menu by driving its UI: type `/`, read the screen, scroll with
 * arrow keys for more, then either complete a command or press Esc to back out.
 */
export class SlashMenu {
  commands: SlashCommand[] = [];
  /** The menu wrapped back to its first command: everything has been seen. */
  complete = false;
  private open_ = false;
  /** Rows the agent's selection has moved down since the menu opened. */
  private cursor = 0;
  /** First command on the last screen read, to tell a redraw from a stale read. */
  private top = '';

  constructor(
    private readonly query: Query,
    private readonly paneId: string,
    private readonly sleep: Sleep = defaultSleep,
    /** How long to wait for the menu to appear, and how often to look. */
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

  /** Polls the screen until it shows commands or the timeout passes. */
  private async poll(): Promise<SlashCommand[]> {
    for (let waited = 0; ; waited += this.pollMs) {
      const found = parseSlashMenu(await this.read());
      if (found.length || waited >= this.timeoutMs) return found;
      await this.sleep(this.pollMs);
    }
  }

  /** Types `/` and returns the commands the agent shows. Empty if it showed none. */
  async open(): Promise<SlashCommand[]> {
    // A `/` left over from an interrupted palette would otherwise become `//`.
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

  /** Reads until the first visible command differs from the last read (or a few tries pass). */
  private async nextPage(): Promise<SlashCommand[]> {
    let page: SlashCommand[] = [];
    for (let tries = 0; tries < 4; tries++) {
      await this.sleep(this.pollMs);
      page = parseSlashMenu(await this.read());
      if (page.length && page[0].name !== this.top) break;
    }
    return page;
  }

  /**
   * A step jumped past the end and the menu wrapped to the top, possibly skipping the last few
   * commands. Step back, then walk down one row at a time until it wraps again.
   */
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

  /**
   * Scrolls the agent's menu to show up to `rows` more commands. Menus scroll only once the
   * selection passes their last visible row, so the selection first moves to the last command
   * seen, then down in steps of `step`, reading after each. Menus that wrap around come back to
   * their first command, which marks the list complete; a menu that stops changing just ends
   * this round.
   */
  async more(rows = 10, step = 5): Promise<SlashCommand[]> {
    if (this.complete || !this.commands.length) return this.commands;
    const first = this.commands[0].name;
    const target = this.commands.length + rows;
    await this.down(this.commands.length - 1 - this.cursor);
    while (this.commands.length < target) {
      await this.down(step);
      // The agent redraws asynchronously; read until the visible page changes.
      const page = await this.nextPage();
      if (page[0]?.name === first) {
        await this.finishAfterWrap(step, first);
        break;
      }
      const before = this.commands.length;
      this.commands = mergeCommands(this.commands, page);
      // No change even after waiting: stop here; the user can try again.
      if (this.commands.length === before) break;
      this.top = page[0]?.name ?? this.top;
    }
    return this.commands;
  }

  /**
   * Types the rest of the command after the `/`, then presses Enter as a separate request: sent
   * in one write, some agents (opencode) take the text and Enter as a paste and drop the `/`.
   */
  async choose(name: string): Promise<void> {
    await this.query('pane.send_text', { pane_id: this.paneId, text: name.replace(/^\//, '') });
    await this.sleep(this.pollMs);
    await this.query('pane.send_keys', { pane_id: this.paneId, keys: ['enter'] });
    this.open_ = false;
  }

  /** Closes the menu with Esc, and removes the `/` if the agent left it in its input. */
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
