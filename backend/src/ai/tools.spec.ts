import { TOOL_DEFINITIONS } from '../ai/tools';

const REQUIRED_TOOLS = [
  'get_customer',
  'get_order',
  'get_product',
  'get_plan',
  'get_payment_status',
  'get_subscription_status',
  'search_knowledge_base',
  'create_support_ticket',
  'request_human_agent',
];

describe('AI tool boundary (exactly nine tools)', () => {
  it('exposes exactly the nine approved tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toHaveLength(9);
    expect(names.sort()).toEqual([...REQUIRED_TOOLS].sort());
  });

  it('has no duplicates', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a description (no undocumented capabilities)', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description?.length).toBeGreaterThan(10);
    }
  });

  it('does not expose raw database access, price setting, or payment approval tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    const forbidden = ['sql', 'query', 'exec', 'approve', 'refund', 'set_price', 'delete', 'update'];
    for (const f of forbidden) {
      expect(names.some((n) => n.includes(f))).toBe(false);
    }
  });
});
