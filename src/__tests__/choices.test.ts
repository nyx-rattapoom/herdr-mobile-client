import { readFileSync } from 'fs';
import { join } from 'path';

import { parseAnsi } from '../live/ansi';
import { answerSteps, parseChoices } from '../live/choices';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const screen = (s: string) => parseAnsi(s);

describe('parseChoices', () => {
  it("reads opencode's permission buttons and which one is highlighted", () => {
    const set = parseChoices(screen(fixture('opencode-permission.ansi')));
    expect(set).toMatchObject({
      layout: 'horizontal',
      choices: [
        { label: 'Allow once', index: 0 },
        { label: 'Allow always', index: 1 },
        { label: 'Reject', index: 2 },
      ],
      selected: 0,
    });
    expect(set?.context).toEqual(['△ Permission required', '# Shell command', '$ ls -la ~/demo']);
  });

  it('finds the buttons in plain text too, without knowing the highlight', () => {
    const set = parseChoices(screen(fixture('opencode-permission.txt')));
    expect(set?.choices.map((c) => c.label)).toEqual(['Allow once', 'Allow always', 'Reject']);
    expect(set?.selected).toBeNull();
  });

  it('reads a numbered list with a selection marker', () => {
    const set = parseChoices(
      screen(
        [
          'Edit config.ts?',
          '',
          ' ❯ 1. Yes',
          '   2. Yes, and allow edits for this session',
          '   3. No, and tell me what to do differently',
          '',
          ' Esc to cancel',
        ].join('\n'),
      ),
    );
    expect(set).toMatchObject({ layout: 'vertical', selected: 0 });
    expect(set?.choices.map((c) => [c.key, c.label])).toEqual([
      ['1', 'Yes'],
      ['2', 'Yes, and allow edits for this session'],
      ['3', 'No, and tell me what to do differently'],
    ]);
    expect(set?.context).toEqual(['Edit config.ts?']);
  });

  it('reads lettered options inside a box, and ignores numbered text that is not a list', () => {
    const set = parseChoices(screen('│ Which branch?      │\n│ a) main            │\n│ b) develop         │'));
    expect(set?.choices.map((c) => c.label)).toEqual(['main', 'develop']);
    expect(set?.selected).toBeNull();
    expect(parseChoices(screen('Step 2. Build the app\nStep 3. Ship it'))).toBeNull();
    expect(parseChoices(screen('2. second\n3. third'))).toBeNull();
  });

  it('reads a [y/n] prompt', () => {
    expect(parseChoices(screen('Overwrite out.txt? [y/N] '))).toMatchObject({
      layout: 'yesno',
      choices: [{ label: 'Yes' }, { label: 'No' }],
      context: ['Overwrite out.txt? [y/N]'],
    });
  });

  it('spots the highlighted button by inverse video', () => {
    const set = parseChoices(screen('Continue?\n  Proceed   \x1b[7mCancel\x1b[0m   Details\n  ←/→ select'));
    expect(set).toMatchObject({ layout: 'horizontal', selected: 1 });
  });

  it('returns null when nothing looks like a question', () => {
    expect(parseChoices(screen('$ ls\nREADME.md   src   package.json\n$'))).toBeNull();
    expect(parseChoices([])).toBeNull();
  });
});

describe('answerSteps', () => {
  it('moves with arrows from the highlighted option, then confirms', () => {
    const set = parseChoices(screen(fixture('opencode-permission.ansi')))!;
    expect(answerSteps(set, 0)).toEqual([{ keys: ['enter'] }]);
    expect(answerSteps(set, 2)).toEqual([{ keys: ['right', 'right'] }, { keys: ['enter'] }]);
    const vertical = parseChoices(screen(' 1. A\n ❯ 2. B\n 3. C'))!;
    expect(answerSteps(vertical, 0)).toEqual([{ keys: ['up'] }, { keys: ['enter'] }]);
  });

  it('types the number or letter when no option is highlighted, and y/n plus Enter', () => {
    expect(answerSteps(parseChoices(screen(' 1. A\n 2. B'))!, 1)).toEqual([{ text: '2' }]);
    expect(answerSteps(parseChoices(screen('Delete? (y/n)'))!, 0)).toEqual([{ text: 'y' }, { keys: ['enter'] }]);
  });
});
