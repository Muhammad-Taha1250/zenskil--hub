import { resolveDispatchChannel, type DispatchContext } from './dispatch-policy';

describe('resolveDispatchChannel — window/template/opt-in matrix', () => {
  const cases: Array<[string, DispatchContext, { allowed: boolean; channel?: string; reason?: string }]> = [
    // free-form: window is the only gate
    ['free-form in window, opted in', { channel: 'free-form', inWindow: true, optedIn: true }, { allowed: true, channel: 'free-form' }],
    ['free-form in window, opted OUT', { channel: 'free-form', inWindow: true, optedIn: false }, { allowed: true, channel: 'free-form' }],
    ['free-form outside window, opted in', { channel: 'free-form', inWindow: false, optedIn: true }, { allowed: false, reason: 'outside_24h_window' }],
    ['free-form outside window, opted out', { channel: 'free-form', inWindow: false, optedIn: false }, { allowed: false, reason: 'outside_24h_window' }],
    // template: opt-in is the only gate (works outside the window — the point of templates)
    ['template in window, opted in', { channel: 'template', inWindow: true, optedIn: true }, { allowed: true, channel: 'template' }],
    ['template outside window, opted in', { channel: 'template', inWindow: false, optedIn: true }, { allowed: true, channel: 'template' }],
    ['template in window, opted OUT', { channel: 'template', inWindow: true, optedIn: false }, { allowed: false, reason: 'not_opted_in' }],
    ['template outside window, opted OUT', { channel: 'template', inWindow: false, optedIn: false }, { allowed: false, reason: 'not_opted_in' }],
  ];

  it.each(cases)('%s', (_name, ctx, expected) => {
    expect(resolveDispatchChannel(ctx)).toEqual(expected);
  });

  it('is total: every (channel, window, opt-in) combination returns a decision', () => {
    for (const channel of ['free-form', 'template'] as const) {
      for (const inWindow of [true, false]) {
        for (const optedIn of [true, false]) {
          const d = resolveDispatchChannel({ channel, inWindow, optedIn });
          expect(d.allowed).toBeDefined();
          if (d.allowed) expect(['free-form', 'template']).toContain(d.channel);
          else expect(['outside_24h_window', 'not_opted_in']).toContain(d.reason);
        }
      }
    }
  });
});
