import { parseLayout, unplacedTerminals } from '../core/layout';
import type { CoreTerminal } from '../core/types';

const terminal = (address: string): CoreTerminal => ({
  address,
  name: null,
  title: address,
  labels: {},
  state: 'live',
  turn: 0,
  status: null,
  cols: 80,
  rows: 24,
  createdMs: 0,
  finishedMs: null,
  exitCode: null,
  signal: null,
  reason: null,
  screen: 'exact',
  keep: false,
  parent: null,
  foreground: null,
  reported: false,
});

const doc = {
  spaces: [
    {
      id: 's1',
      name: 'work',
      folder: '/home/u/work',
      tabs: [
        {
          id: 'tab1',
          name: 'api',
          root: {
            type: 'row',
            children: [
              { type: 'block', content: { terminal: 't1' } },
              {
                type: 'column',
                children: [
                  { type: 'stack', children: [] },
                  { type: 'block', content: { terminal: 't2' }, floating: [{ content: { terminal: 't3' }, edge: 'right' }] },
                ],
              },
            ],
          },
        },
        { id: 'tab2', name: 'misc', root: { type: 'block', content: { mod: 'clock' } } },
      ],
    },
    { id: 's2', name: 'empty', folder: '', tabs: [] },
  ],
};

describe('core layout document', () => {
  it('reads spaces, tabs and terminal blocks through containers and floating blocks', () => {
    const layout = parseLayout(doc);
    expect(layout?.spaces.map((s) => [s.name, s.folder])).toEqual([
      ['work', '/home/u/work'],
      ['empty', ''],
    ]);
    expect(layout?.spaces[0].tabs.map((t) => [t.name, t.terminals])).toEqual([
      ['api', ['t1', 't2', 't3']],
      ['misc', []],
    ]);
    expect([...(layout?.placed ?? [])].sort()).toEqual(['t1', 't2', 't3']);
  });

  it('lists terminals that the desktop document does not place', () => {
    const layout = parseLayout(doc);
    const all = [terminal('t1'), terminal('t2'), terminal('t9')];
    expect(unplacedTerminals(layout, all).map((t) => t.address)).toEqual(['t9']);
  });

  it('treats a missing document as no layout and keeps every terminal listed', () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout(undefined)).toBeNull();
    const all = [terminal('t1')];
    expect(unplacedTerminals(null, all)).toEqual(all);
  });

  it('ignores unknown blocks and fields without inventing terminals', () => {
    const layout = parseLayout({
      spaces: [
        {
          id: 's',
          name: 'n',
          tabs: [{ id: 't', name: 'x', root: { type: 'hyperspace', content: { terminal: 'nope' }, children: [{ type: 'block', content: { agent: 'z' } }] } }],
        },
      ],
      future_field: { anything: true },
    });
    expect(layout?.spaces[0].tabs[0].terminals).toEqual([]);
    expect(layout?.placed.size).toBe(0);
  });

  it('survives malformed nodes and non-object input', () => {
    expect(parseLayout('nope')).toEqual({ spaces: [], placed: new Set() });
    const layout = parseLayout({ spaces: [{ id: 's', tabs: [{ id: 't', root: { type: 'row', children: [null, 5, { type: 'block', content: null }] } }] }] });
    expect(layout?.spaces[0].tabs[0].terminals).toEqual([]);
  });
});
