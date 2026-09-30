import { redactPII, redactPIIJson } from './pii-redaction';

describe('pii-redaction', () => {
  it('masks Pakistani mobile numbers', () => {
    expect(redactPII('my number is 03001234567 call me')).toBe('my number is [redacted-digits] call me');
  });

  it('masks CNIC with dashes and card numbers', () => {
    expect(redactPII('CNIC 35202-1234567-8')).toBe('CNIC [redacted-digits]');
    expect(redactPII('card 4111111111111111')).toBe('card [redacted-digits]');
  });

  it('masks sensitive keys in JSON-ish text', () => {
    const out = redactPII('{"password": "hunter2", "ok": true}');
    expect(out).toContain('"password": "[redacted]"');
    expect(out).toContain('"ok": true');
    expect(out).not.toContain('hunter2');
  });

  it('masks emails', () => {
    expect(redactPII('mail me at ali@example.com')).toBe('mail me at [redacted-email]');
  });

  it('leaves prices, order numbers and short numbers readable', () => {
    expect(redactPII('plan costs 210000 paisa')).toBe('plan costs 210000 paisa');
    expect(redactPII('order ZSH-20240101-12345')).toBe('order ZSH-20240101-12345');
    expect(redactPII('in 2026')).toBe('in 2026');
  });

  it('redactPIIJson masks sensitive keys and digit runs in structures', () => {
    const out = redactPIIJson({
      name: 'Ali',
      whatsapp: '03001234567',
      nested: { cnic: '3520212345678', note: 'call 03001234567' },
      list: ['a', '4111111111111111'],
    }) as Record<string, unknown>;
    expect(out.name).toBe('Ali');
    expect(out.whatsapp).toBe('[redacted-digits]');
    expect((out.nested as Record<string, unknown>).cnic).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).note).toBe('call [redacted-digits]');
    expect((out.list as string[])[1]).toBe('[redacted-digits]');
  });
});
