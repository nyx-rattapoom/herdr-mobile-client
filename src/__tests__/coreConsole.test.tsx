import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CoreConsoleScreen } from '../screens/CoreConsoleScreen';
import { CoreSession, type CoreSessionSnapshot } from '../core/CoreSession';
import { TestCore, coreRecord } from '../testing/corePeer';
import { FakeByteTransport, flush } from '../testing/byteFakes';
import type { ServerProfile } from '../store/servers';

const server: ServerProfile = { id: 's1', label: 'core box', host: 'h', port: 22, username: 'u', backend: 'core' };

const tree = (session: CoreSession, snap: CoreSessionSnapshot) => (
  <CoreConsoleScreen server={server} session={session} snapshot={snap} onBack={() => {}} onReconnect={() => {}} />
);

function renderList(session: CoreSession): ReactTestRenderer {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(tree(session, session.snapshot()));
  });
  return r!;
}

function rerender(r: ReactTestRenderer, session: CoreSession): void {
  act(() => {
    r.update(tree(session, session.snapshot()));
  });
}

/** Every rendered terminal row, grouped and unplaced alike. */
const rows = (r: ReactTestRenderer) =>
  [
    ...new Set(
      r.root
        .findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('core-terminal-'))
        .map((n) => n.props.testID as string),
    ),
  ].sort();

const texts = (r: ReactTestRenderer) =>
  r.root.findAll((n) => typeof n.props.children === 'string').map((n) => n.props.children as string);

describe('CoreConsoleScreen document failures', () => {
  it('keeps every live terminal listed when a document refresh fails, then regroups on recovery', async () => {
    const t = new FakeByteTransport();
    const core = new TestCore(t, [coreRecord('t7'), coreRecord('t9')]);
    const session = new CoreSession(async () => t);
    await session.start();

    // Placed t7 groups under the space/tab; t9 falls to Unplaced.
    const r = renderList(session);
    expect(rows(r)).toEqual(['core-terminal-t7', 'core-terminal-t9']);
    expect(texts(r)).toContain('Unplaced terminals');
    expect(texts(r).some((s) => s.includes('Desktop layout is unavailable'))).toBe(false);

    // The next herdr-app refresh fails; the retained layout must not hide t7.
    core.failOnce.add('doc.get');
    core.docVersion = 2;
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 11, type: 'doc', data: { name: 'herdr-app', version: 2 } } });
    await flush();
    const failed = session.snapshot();
    expect(failed.docError).toBe('busy');
    expect(failed.layout?.placed.has('t7')).toBe(true);
    rerender(r, session);
    expect(rows(r)).toEqual(['core-terminal-t7', 'core-terminal-t9']);
    expect(texts(r).some((s) => s.includes('Desktop layout is unavailable (busy)'))).toBe(true);

    // The same version re-announced retries successfully and grouping returns.
    core.event({ jsonrpc: '2.0', method: 'event', params: { seq: 12, type: 'doc', data: { name: 'herdr-app', version: 2 } } });
    await flush();
    expect(session.snapshot()).toMatchObject({ status: 'live', docError: null });
    rerender(r, session);
    expect(rows(r)).toEqual(['core-terminal-t7', 'core-terminal-t9']);
    expect(texts(r).some((s) => s.includes('Desktop layout is unavailable'))).toBe(false);
    act(() => {
      r.unmount();
    });
    session.close();
  });
});
