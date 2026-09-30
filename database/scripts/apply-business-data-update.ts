/**
 * One-off business data update (owner-directed, 2026-09-24):
 *  1. payment.instructions system setting -> NayaPay receiving details (H-6)
 *  2. business_hours rows -> 24/7 (G-10)
 *  3. KB document "Refund Policy" -> PUBLISHED with chunks (G-4)
 * Idempotent: safe to re-run.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PAYMENT_INSTRUCTIONS = {
  'Bank Name': 'NayaPay',
  'Account Title': 'Chand Zohaib',
  'Account Number': '03709104250',
};

const REFUND_POLICY_SLUG = 'refund-policy';
const REFUND_POLICY_TEXT =
  'Refunds are available if your service has not been delivered or activated, ' +
  'or if there is a genuine technical/fulfillment issue that we cannot resolve. ' +
  'Once the service has been successfully activated and delivered, refunds are ' +
  'generally not available. Duplicate payments are reviewed separately. All ' +
  'refund requests are verified and reviewed by our support team.';

async function main() {
  // 1. payment.instructions (H-6)
  await prisma.systemSetting.upsert({
    where: { key: 'payment.instructions' },
    create: {
      key: 'payment.instructions',
      value: PAYMENT_INSTRUCTIONS,
      description: 'Owner-configured receiving account/wallet details shown to customers (H-6).',
    },
    update: {
      value: PAYMENT_INSTRUCTIONS,
      description: 'Owner-configured receiving account/wallet details shown to customers (H-6).',
    },
  });
  console.log('OK: payment.instructions upserted');

  // 2. business hours -> 24/7 (G-10): open all day, every day (Asia/Karachi).
  for (let dow = 0; dow <= 6; dow++) {
    await prisma.businessHours.upsert({
      where: { dayOfWeek: dow },
      create: { dayOfWeek: dow, openTime: '00:00', closeTime: '23:59', isClosed: false, timezone: 'Asia/Karachi' },
      update: { openTime: '00:00', closeTime: '23:59', isClosed: false, timezone: 'Asia/Karachi' },
    });
  }
  console.log('OK: business_hours set to 24/7 (7 rows)');

  // 3. Refund Policy KB document (G-4), PUBLISHED, chunked for search.
  // Strictly idempotent: if the stored content already matches, touch nothing
  // (no version bump, no chunk rewrite).
  const existing = await prisma.knowledgeBaseDocument.findUnique({ where: { slug: REFUND_POLICY_SLUG } });
  if (existing) {
    if (existing.content === REFUND_POLICY_TEXT && existing.status === 'PUBLISHED' && existing.title === 'Refund Policy') {
      console.log('OK: refund-policy KB document already up to date (no changes)');
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.knowledgeBaseDocument.update({
          where: { slug: REFUND_POLICY_SLUG },
          data: {
            title: 'Refund Policy',
            content: REFUND_POLICY_TEXT,
            status: 'PUBLISHED',
            version: { increment: 1 },
          },
        });
        await tx.knowledgeBaseChunk.deleteMany({ where: { documentId: existing.id } });
        await tx.knowledgeBaseChunk.create({
          data: { documentId: existing.id, chunkIndex: 0, content: REFUND_POLICY_TEXT },
        });
      });
      console.log('OK: refund-policy KB document updated + PUBLISHED');
    }
  } else {
    await prisma.$transaction(async (tx) => {
      const doc = await tx.knowledgeBaseDocument.create({
        data: {
          slug: REFUND_POLICY_SLUG,
          title: 'Refund Policy',
          language: 'en',
          content: REFUND_POLICY_TEXT,
          status: 'PUBLISHED',
        },
      });
      await tx.knowledgeBaseChunk.create({
        data: { documentId: doc.id, chunkIndex: 0, content: REFUND_POLICY_TEXT },
      });
    });
    console.log('OK: refund-policy KB document created + PUBLISHED');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('FAILED:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
