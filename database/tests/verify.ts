// Phase 2 verification suite: schema, seeds, order numbers, constraints.
// Run: npm test   (requires DATABASE_URL and migrated DB)

import { PrismaClient } from "@prisma/client";
import { seed } from "../prisma/seed.js";
import {
  formatOrderNumber,
  generateOrderNumber,
  isValidOrderNumber,
  karachiDayString,
} from "../src/orderNumber.js";

const prisma = new PrismaClient();
let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const EXPECTED_PRICES: Record<string, number> = {
  "1 Month": 83000,
  "2 Months": 150000,
  "3 Months": 210000,
  "6 Months": 360000,
  "12 Months": 600000,
};

const EXPECTED_STATES = [
  "NEW", "BROWSING", "SELECTING_PRODUCT", "SELECTING_PLAN",
  "WAITING_FOR_CUSTOMER_DETAILS", "ORDER_CREATED", "AWAITING_PAYMENT",
  "PAYMENT_PROCESSING", "PAYMENT_CONFIRMED", "FULFILLMENT_PENDING",
  "FULFILLMENT_PROCESSING", "FULFILLED", "ACTIVE", "EXPIRING_SOON",
  "EXPIRED", "SUPPORT_REQUIRED", "CANCELLED", "REFUND_REQUESTED", "REFUNDED",
];

async function main(): Promise<void> {
  console.log("== seed idempotency ==");
  await seed();
  const counts1 = {
    products: await prisma.product.count(),
    plans: await prisma.plan.count(),
    kb: await prisma.knowledgeBaseDocument.count(),
    settings: await prisma.systemSetting.count(),
    hours: await prisma.businessHours.count(),
  };
  await seed();
  const counts2 = {
    products: await prisma.product.count(),
    plans: await prisma.plan.count(),
    kb: await prisma.knowledgeBaseDocument.count(),
    settings: await prisma.systemSetting.count(),
    hours: await prisma.businessHours.count(),
  };
  check("seed is idempotent", JSON.stringify(counts1) === JSON.stringify(counts2),
    `${JSON.stringify(counts1)} vs ${JSON.stringify(counts2)}`);

  console.log("== plans: exact spec prices ==");
  const plans = await prisma.plan.findMany({
    where: { product: { slug: "learning-access" } },
    orderBy: { sortOrder: "asc" },
  });
  check("5 learning plans exist", plans.length === 5, `found ${plans.length}`);
  for (const p of plans) {
    check(`plan "${p.name}" = PKR ${EXPECTED_PRICES[p.name] / 100}`,
      p.pricePaisa === EXPECTED_PRICES[p.name] && p.currency === "PKR" && p.isActive,
      `got ${p.pricePaisa} ${p.currency}`);
  }

  console.log("== placeholder categories inactive ==");
  const placeholders = await prisma.product.findMany({
    where: { slug: { in: ["digital-tools", "youtube-services", "technology-services"] } },
  });
  check("3 placeholders exist and are inactive",
    placeholders.length === 3 && placeholders.every((p) => !p.isActive));

  console.log("== knowledge base drafts ==");
  const kb = await prisma.knowledgeBaseDocument.findMany();
  check("12 KB documents seeded", kb.length === 12, `found ${kb.length}`);
  // Owner-directed exception (2026-09-24): the Refund Policy is PUBLISHED by
  // owner order; every other seeded document must remain DRAFT.
  check(
    "all KB documents are DRAFT except owner-published refund-policy",
    kb.every((d) => d.status === "DRAFT" || (d.slug === "refund-policy" && d.status === "PUBLISHED")),
  );

  console.log("== customer state enum: all 19 states ==");
  const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'CustomerState' ORDER BY e.enumsortorder`;
  const labels = rows.map((r) => r.enumlabel);
  check("CustomerState has all 19 values",
    EXPECTED_STATES.every((s) => labels.includes(s)) && labels.length === 19,
    `got [${labels.join(",")}]`);

  console.log("== order numbers: concurrent uniqueness ==");
  const day = karachiDayString();
  const generated = await Promise.all(
    Array.from({ length: 100 }, () => generateOrderNumber(prisma)),
  );
  const unique = new Set(generated);
  check("100 concurrent order numbers are unique", unique.size === 100);
  check("all match ZSH-YYYYMMDD-XXXXX",
    generated.every((n) => isValidOrderNumber(n) && n.startsWith(`ZSH-${day}-`)),
    generated.find((n) => !isValidOrderNumber(n)));
  const seqs = generated.map((n) => parseInt(n.slice(-5), 10)).sort((a, b) => a - b);
  check("sequence is gapless for this batch",
    seqs.every((s, i) => s === seqs[0] + i), seqs.slice(0, 5).join(","));

  console.log("== order number format helpers ==");
  check("formatOrderNumber pads correctly", formatOrderNumber("20260924", 7) === "ZSH-20260924-00007");
  let threw = false;
  try { formatOrderNumber("20260924", 100000); } catch { threw = true; }
  check("sequence > 99999 rejected", threw);

  console.log("== unique constraints ==");
  const cust = await prisma.customer.create({
    data: { whatsappNumber: "+923001234567", name: "Test User" },
  });
  let dupRejected = false;
  try {
    await prisma.customer.create({ data: { whatsappNumber: "+923001234567" } });
  } catch (e: unknown) {
    dupRejected = e instanceof Error && "code" in e && (e as { code: string }).code === "P2002";
  }
  check("duplicate whatsapp_number rejected (P2002)", dupRejected);

  console.log("== invalid enum rejected ==");
  let enumRejected = false;
  try {
    await prisma.$executeRaw`
      INSERT INTO "customers" ("id","whatsapp_number","state","created_at","updated_at")
      VALUES (gen_random_uuid(), '+923009876543', 'BOGUS_STATE', now(), now())`;
  } catch { enumRejected = true; }
  check("invalid customer state rejected by DB enum", enumRejected);

  console.log("== append-only audit_logs ==");
  const log = await prisma.auditLog.create({
    data: { actorType: "SYSTEM", action: "verify.append_only", entityType: "test" },
  });
  const upd = await prisma.$executeRaw`
    UPDATE "audit_logs" SET "action"='tampered' WHERE "id"=${log.id}::uuid`;
  const after = await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } });
  check("audit_logs UPDATE blocked (0 rows, value intact)",
    upd === 0 && after.action === "verify.append_only", `rows=${upd}`);
  const del = await prisma.$executeRaw`
    DELETE FROM "audit_logs" WHERE "id"=${log.id}::uuid`;
  const stillThere = await prisma.auditLog.findUnique({ where: { id: log.id } });
  check("audit_logs DELETE blocked", del === 0 && stillThere !== null);

  console.log("== money stored as integer paisa ==");
  const plan = await prisma.plan.findFirstOrThrow({ where: { name: "1 Month" } });
  check("1 Month plan = 83000 paisa integer", plan.pricePaisa === 83000 && Number.isInteger(plan.pricePaisa));

  // cleanup test rows (financial tables untouched)
  await prisma.customer.delete({ where: { id: cust.id } });

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
