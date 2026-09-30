// Unit tests for template body rendering (Baileys refactor): with no
// server-side template registry, the backend must substitute {{1}}..{{n}}
// locally — and fail loud on bad data instead of shipping fragments.
import { BadRequestException } from '@nestjs/common';
import { renderTemplateBody } from './whatsapp.service';

describe('renderTemplateBody', () => {
  it('substitutes placeholders in order', () => {
    expect(
      renderTemplateBody('Hi {{1}}! Order {{2}} (PKR {{3}}).', ['Ahmed', 'ZSH-1', '2,100']),
    ).toBe('Hi Ahmed! Order ZSH-1 (PKR 2,100).');
  });

  it('substitutes the same placeholder used twice', () => {
    expect(renderTemplateBody('Order {{1}}: {{1}} delivered.', ['ZSH-9'])).toBe(
      'Order ZSH-9: ZSH-9 delivered.',
    );
  });

  it('throws BadRequestException when a placeholder has no variable', () => {
    expect(() => renderTemplateBody('Hi {{1}}, amount {{2}}.', ['only-one'])).toThrow(
      BadRequestException,
    );
  });

  it('throws when a placeholder index skips ahead', () => {
    expect(() => renderTemplateBody('Pay {{3}} now.', ['a', 'b'])).toThrow(BadRequestException);
  });

  it('leaves text without placeholders untouched', () => {
    expect(renderTemplateBody('No placeholders here.', [])).toBe('No placeholders here.');
  });

  it('accepts extra variables beyond the highest placeholder', () => {
    expect(renderTemplateBody('Hi {{1}}.', ['a', 'b', 'c'])).toBe('Hi a.');
  });

  it('passes variable values through verbatim (no re-interpretation)', () => {
    expect(renderTemplateBody('Say {{1}}.', ['{{2}}'])).toBe('Say {{2}}.');
  });
});
