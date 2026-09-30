// ZenSkil Hub — database seed (Phase 2).
// Idempotent: safe to run multiple times (upserts on unique keys).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// WhatsApp template bodies — Baileys refactor (2026-09-26). Meta hosted these
// bodies server-side; with Baileys the backend renders them locally from this
// table (owner-editable via the admin panel). Text matches the owner-approved
// drafts in workflows/n8n/message-templates.draft.md. Placeholders {{1}}..{{n}}
// are substituted in order by WhatsappService.renderTemplateBody.
const MESSAGE_TEMPLATES: Array<{ name: string; language: string; body: string }> = [
  {
    name: 'zenskill_abandoned_reminder_1',
    language: 'en',
    body: 'Assalam-o-Alaikum {{1}}! Your ZenSkil Hub order {{2}} (PKR {{3}}) is still waiting for payment. Reply YES to continue, or tap below to change your plan. — ZenSkil Hub · LEARN • BUILD • GROW',
  },
  {
    name: 'zenskill_abandoned_reminder_1',
    language: 'ur',
    body: 'السلام علیکم {{1}}! آپ کا زین سکل ہب آرڈر {{2}} (روپے {{3}}) ابھی تک ادائیگی کا منتظر ہے۔ جاری رکھنے کے لیے YES لکھیں۔',
  },
  {
    name: 'zenskill_abandoned_reminder_2',
    language: 'en',
    body: '{{1}}, this is the last reminder: your order {{2}} will be cancelled soon if payment is not received. Reply YES to keep it, or CANCEL to release it. Need help? Reply SUPPORT.',
  },
  {
    name: 'zenskill_abandoned_reminder_2',
    language: 'ur',
    body: '{{1}}، یہ آخری یاد دہانی ہے: ادائیگی نہ ملنے پر آپ کا آرڈر {{2}} منسوخ ہو جائے گا۔ جاری رکھنے کے لیے YES لکھیں۔',
  },
  {
    name: 'zenskill_renewal_reminder',
    language: 'en',
    body: 'Assalam-o-Alaikum {{1}}! Your {{2}} plan renews on {{3}} (PKR {{4}}). Reply RENEW to continue without interruption, or PLANS to change your plan.',
  },
  {
    name: 'zenskill_renewal_reminder',
    language: 'ur',
    body: 'السلام علیکم {{1}}! آپ کا {{2}} پلان {{3}} کو تجدید ہوگا (روپے {{4}})۔ جاری رکھنے کے لیے RENEW لکھیں۔',
  },
  {
    name: 'zenskill_payment_confirmation',
    language: 'en',
    body: 'Shukriya {{1}}! We received PKR {{2}} for order {{3}}. Your payment is confirmed and your order is being prepared. — ZenSkil Hub',
  },
  {
    name: 'zenskill_payment_confirmation',
    language: 'ur',
    body: 'شکریہ {{1}}! آرڈر {{3}} کے لیے روپے {{2}} موصول ہو گئے ہیں۔ ادائیگی کی تصدیق ہو گئی ہے۔',
  },
  {
    name: 'zenskill_support_followup',
    language: 'en',
    body: 'Assalam-o-Alaikum {{1}}! Following up on your ticket {{2}} — our team is on it. Reply here if you need anything else. — ZenSkil Hub Support',
  },
  {
    name: 'zenskill_support_followup',
    language: 'ur',
    body: 'السلام علیکم {{1}}! آپ کی ٹکٹ {{2}} پر ہماری ٹیم کام کر رہی ہے۔ مزید مدد درکار ہو تو یہیں جواب دیں۔',
  },
  {
    name: 'order_fulfilled',
    language: 'en',
    body: 'Assalam-o-Alaikum {{1}}! Your {{2}} ({{3}}) is ready — order {{1}} has been delivered. It stays active until {{4}}. Reply here if you need help. — ZenSkil Hub',
  },
  {
    name: 'order_fulfilled',
    language: 'ur',
    body: 'السلام علیکم {{1}}! آپ کا {{2}} ({{3}}) تیار ہے — آرڈر {{1}} ڈیلیور کر دیا گیا ہے۔ یہ {{4}} تک فعال رہے گا۔ مدد درکار ہو تو یہیں جواب دیں۔',
  },
];

// Exact prices from the master spec, in paisa (PKR * 100).
const LEARNING_PLANS = [
  { name: "1 Month", durationMonths: 1, durationDays: 30, pricePaisa: 83000, sortOrder: 1 },
  { name: "2 Months", durationMonths: 2, durationDays: 60, pricePaisa: 150000, sortOrder: 2 },
  { name: "3 Months", durationMonths: 3, durationDays: 90, pricePaisa: 210000, sortOrder: 3 },
  { name: "6 Months", durationMonths: 6, durationDays: 180, pricePaisa: 360000, sortOrder: 4 },
  { name: "12 Months", durationMonths: 12, durationDays: 365, pricePaisa: 600000, sortOrder: 5 },
] as const;

const KB_DRAFTS: Array<{ slug: string; title: string; content: string }> = [
  {
    slug: "about-zenskill-hub",
    title: "About ZenSkil Hub",
    content:
      "DRAFT — owner to complete.\n\nZenSkil Hub (LEARN • BUILD • GROW) is a Pakistan-focused digital learning and technology services brand.\n\n[Describe the business, mission, and what customers can expect.]",
  },
  {
    slug: "products",
    title: "Products",
    content:
      "DRAFT — owner to complete.\n\n[List each product/service, what it includes, and who it is for. The AI may only describe what is written here.]",
  },
  {
    slug: "plans-and-pricing",
    title: "Plans & Prices",
    content:
      "DRAFT — owner to complete.\n\nLearning Access plans: 1 Month PKR 830, 2 Months PKR 1,500, 3 Months PKR 2,100, 6 Months PKR 3,600, 12 Months PKR 6,000.\n\n[Add any other product pricing. Prices shown to customers always come from the database; this document is descriptive only.]",
  },
  {
    slug: "how-it-works",
    title: "How It Works",
    content:
      "DRAFT — owner to complete.\n\n[Step-by-step: how a customer browses, orders, pays, and receives the service. How long each step takes.]",
  },
  {
    slug: "what-you-receive",
    title: "What You Receive",
    content:
      "DRAFT — owner to complete. REQUIRED before fulfillment can be automated.\n\n[For each product: exactly what the customer receives and how it is delivered (e.g. login credentials by email, invite link, etc.).]",
  },
  {
    slug: "payment-methods",
    title: "Payment Methods",
    content:
      "DRAFT — owner to complete.\n\n[Accepted payment methods: bank transfer, JazzCash, Easypaisa, etc. Include the receiving account/wallet details shown to customers. Never ask customers for card numbers, CVV, or passwords.]",
  },
  {
    slug: "refund-policy",
    title: "Refund Policy",
    content:
      "DRAFT — owner to complete and approve before launch.\n\n[Time window, conditions, who approves, partial refunds, how the refund is sent.]",
  },
  {
    slug: "delivery-policy",
    title: "Delivery Policy",
    content:
      "DRAFT — owner to complete.\n\n[How and when the service is delivered after payment confirmation. What happens if delivery fails.]",
  },
  {
    slug: "support-policy",
    title: "Support Policy",
    content:
      "DRAFT — owner to complete.\n\n[Support hours (Asia/Karachi), response-time expectations, how to reach human support, escalation path.]",
  },
  {
    slug: "terms",
    title: "Terms of Service",
    content: "DRAFT — owner/legal to complete before launch.\n\n[Terms of service.]",
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    content: "DRAFT — owner/legal to complete before launch.\n\n[What data is collected (name, WhatsApp number, email), why, how long it is kept, customer rights.]",
  },
  {
    slug: "faqs",
    title: "FAQs",
    content:
      "DRAFT — owner to complete.\n\nQ: What do I get?\nA: [answer]\n\nQ: How does it work?\nA: [answer]\n\nQ: How long does it last?\nA: [answer]\n\nQ: How do I receive it?\nA: [answer]\n\nQ: Can I use my email?\nA: [answer]\n\nQ: Can I cancel?\nA: [answer]\n\nQ: What happens if there is a problem?\nA: [answer]\n\nQ: How do I get support?\nA: [answer]\n\nQ: What payment methods are available?\nA: [answer]",
  },
];

const SYSTEM_SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  {
    key: "business.name",
    value: "ZenSkil Hub",
    description: "Brand name shown to customers.",
  },
  {
    key: "business.motto",
    value: "LEARN • BUILD • GROW",
    description: "Brand motto.",
  },
  {
    key: "business.currency",
    value: "PKR",
    description: "Billing currency (v1: PKR only).",
  },
  {
    key: "business.timezone",
    value: "Asia/Karachi",
    description: "Business timezone for display and scheduling.",
  },
  {
    key: "reminders.abandoned",
    value: { enabled: true, offsets_hours: [2, 24], max_attempts: 2 },
    description: "Abandoned-order reminders for AWAITING_PAYMENT orders.",
  },
  {
    key: "reminders.renewal",
    value: { enabled: true, offsets_days: [7, 3, 1] },
    description: "Renewal reminder offsets before subscription expiry.",
  },
  {
    key: "subscription.grace_period_days",
    value: 3,
    description: "Days after expiry before a subscription becomes EXPIRED.",
  },
  {
    key: "payment.window_hours",
    value: 72,
    description: "Hours before an unpaid order auto-cancels.",
  },
  {
    key: "payment.manual_transfer_details",
    value: {
      note: "DRAFT — owner must supply real receiving account/wallet details.",
      accounts: [],
    },
    description: "Transfer details shown to customers for manual payments.",
  },
  {
    key: "payment.instructions",
    value: {
      "Bank Name": "NayaPay",
      "Account Title": "Chand Zohaib",
      "Account Number": "03709104250",
    },
    description:
      "Owner-configured receiving account/wallet details shown to customers and used by the payment-instructions endpoint (H-6).",
  },
  {
    key: "support.auto_close_days",
    value: 7,
    description: "Days after RESOLVED before a ticket auto-closes.",
  },
  {
    key: "templates.abandoned_reminder_1",
    value: "zenskill_abandoned_reminder_1",
    description:
      "Template name for the first abandoned-order reminder (2h). The message body lives in message_templates (owner-editable).",
  },
  {
    key: "templates.abandoned_reminder_2",
    value: "zenskill_abandoned_reminder_2",
    description:
      "Template name for the final abandoned-order reminder (24h). The message body lives in message_templates (owner-editable).",
  },
  {
    key: "templates.renewal_reminder",
    value: "zenskill_renewal_reminder",
    description:
      "Template name for subscription renewal reminders (7d/3d/1d). The message body lives in message_templates (owner-editable).",
  },
  {
    key: "templates.payment_confirmation",
    value: "zenskill_payment_confirmation",
    description:
      "Template name for payment confirmations. The message body lives in message_templates (owner-editable).",
  },
  {
    key: "templates.support_followup",
    value: "zenskill_support_followup",
    description:
      "Template name for support follow-ups. The message body lives in message_templates (owner-editable).",
  },
];

export async function seed(): Promise<void> {
  // --- Products -----------------------------------------------------------
  const learning = await prisma.product.upsert({
    where: { slug: "learning-access" },
    create: {
      slug: "learning-access",
      name: "Learning Access",
      category: "learning",
      shortDescription: "Digital learning service access.",
      longDescription:
        "DRAFT — owner to complete: describe exactly what the customer receives.",
      isActive: true,
      sortOrder: 1,
    },
    update: {},
  });

  // Placeholder categories from the spec menu (inactive until owner defines them).
  const placeholders = [
    { slug: "digital-tools", name: "Digital Tools", category: "digital-tools", sortOrder: 2 },
    { slug: "youtube-services", name: "YouTube Services", category: "youtube", sortOrder: 3 },
    { slug: "technology-services", name: "Technology Services", category: "technology", sortOrder: 4 },
  ];
  for (const p of placeholders) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        name: p.name,
        category: p.category,
        shortDescription: "DRAFT — owner to define this service.",
        isActive: false,
        sortOrder: p.sortOrder,
      },
      update: {},
    });
  }

  // --- Plans (exact spec prices) ------------------------------------------
  for (const plan of LEARNING_PLANS) {
    await prisma.plan.upsert({
      where: { productId_name: { productId: learning.id, name: plan.name } },
      create: {
        productId: learning.id,
        name: plan.name,
        durationMonths: plan.durationMonths,
        durationDays: plan.durationDays,
        pricePaisa: plan.pricePaisa,
        currency: "PKR",
        isActive: true,
        sortOrder: plan.sortOrder,
      },
      update: {
        // Keep price/duration in sync with the spec on re-seed; the owner
        // changes prices via the admin panel (Phase 9), not via seed.
        durationMonths: plan.durationMonths,
        durationDays: plan.durationDays,
        pricePaisa: plan.pricePaisa,
        isActive: true,
      },
    });
  }

  // --- Knowledge base DRAFT skeletons -------------------------------------
  for (const doc of KB_DRAFTS) {
    await prisma.knowledgeBaseDocument.upsert({
      where: { slug: doc.slug },
      create: {
        slug: doc.slug,
        title: doc.title,
        language: "en",
        content: doc.content,
        version: 1,
        status: "DRAFT",
      },
      update: {},
    });
  }

  // --- Message templates (Baileys: bodies live here, rendered locally) -------
  for (const t of MESSAGE_TEMPLATES) {
    await prisma.messageTemplate.upsert({
      where: { name_language: { name: t.name, language: t.language } },
      create: { name: t.name, language: t.language, body: t.body, isActive: true },
      // Never overwrite an owner-edited body: seed only fills gaps.
      update: {},
    });
  }

  // --- System settings ------------------------------------------------------
  for (const s of SYSTEM_SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value as object, description: s.description },
      update: {},
    });
  }

  // --- Business hours (owner-set: 24/7) --------------------------------------
  // 0=Sunday..6=Saturday. Open 24 hours a day, 7 days a week (Asia/Karachi).
  for (let dow = 0; dow <= 6; dow++) {
    await prisma.businessHours.upsert({
      where: { dayOfWeek: dow },
      create: {
        dayOfWeek: dow,
        openTime: "00:00",
        closeTime: "23:59",
        isClosed: false,
        timezone: "Asia/Karachi",
      },
      update: {},
    });
  }

  console.log("Seed complete.");
}

async function run(): Promise<void> {
  try {
    await seed();
  } finally {
    await prisma.$disconnect();
  }
}

// Allow `import { seed } from "./seed"` for tests without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
