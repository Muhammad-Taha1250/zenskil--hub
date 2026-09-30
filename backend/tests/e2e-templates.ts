// Shared E2E fixture: message_templates rows needed by suites that dispatch
// real template notifications (n8n-flow, staging-flow). Production bodies are
// seeded by database/prisma/seed.ts; these compact bodies carry the same
// {{n}} placeholders the renderers assert against.
import type { PrismaClient } from '@prisma/client';

export const TEST_TEMPLATES: Array<{ name: string; body: string }> = [
  { name: 'zenskill_abandoned_reminder_1', body: 'Hi {{1}}, order {{2}} (PKR {{3}}) awaiting payment.' },
  { name: 'zenskill_abandoned_reminder_2', body: 'Final reminder {{1}}: order {{2}} will be cancelled.' },
  { name: 'zenskill_renewal_reminder', body: 'Hi {{1}}, your {{2}} renews on {{3}} (PKR {{4}}).' },
  { name: 'zenskill_payment_confirmation', body: 'Thanks {{1}}! PKR {{2}} received for order {{3}}.' },
  { name: 'zenskill_support_followup', body: 'Hi {{1}}, following up on ticket {{2}}.' },
  { name: 'order_fulfilled', body: 'Hi {{1}}! Your {{2}} ({{3}}) is ready — order {{1}} delivered, active until {{4}}.' },
];

export async function seedTestTemplates(prisma: PrismaClient): Promise<void> {
  for (const t of TEST_TEMPLATES) {
    await prisma.messageTemplate.upsert({
      where: { name_language: { name: t.name, language: 'en' } },
      create: { name: t.name, language: 'en', body: t.body, isActive: true },
      update: { body: t.body, isActive: true },
    });
  }
}
