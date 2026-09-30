# WhatsApp Message Template Drafts (D4)

> **2026-09-26 — Baileys refactor:** Meta template approval no longer applies.
> These drafts are now the **live message bodies**, seeded into the
> `message_templates` table by `database/prisma/seed.ts` and rendered locally
> by the backend (owner-editable via the admin panel — no code changes). The
> original Meta-submission notes below are kept for history.
>
> Variables are shown as `{{1}}`, `{{2}}` … and are substituted in order by
> `WhatsappService.renderTemplateBody`.

<details>
<summary>Historical note (pre-Baileys): Meta WhatsApp Manager submission</summary>

These were once drafts for the owner to submit in Meta's WhatsApp Manager
(message templates, utility category). That submission step is obsolete —
bodies now ship from this table via the seed.
</details>

## 1. Abandoned-order reminder — first nudge (2h)

Name: `zenskill_abandoned_reminder_1` · Category: utility

**English**
> Assalam-o-Alaikum {{1}}! Your ZenSkil Hub order {{2}} (PKR {{3}}) is still
> waiting for payment. Reply YES to continue, or tap below to change your plan.
> — ZenSkil Hub · LEARN • BUILD • GROW

**Roman Urdu**
> Assalam-o-Alaikum {{1}}! Aap ka ZenSkil Hub order {{2}} (PKR {{3}}) abhi tak
> payment ka muntazir hai. Continue karne ke liye YES likhein.

**Urdu**
> السلام علیکم {{1}}! آپ کا زین سکل ہب آرڈر {{2}} (روپے {{3}}) ابھی تک ادائیگی کا
> منتظر ہے۔ جاری رکھنے کے لیے YES لکھیں۔

## 2. Abandoned-order reminder — final nudge (24h)

Name: `zenskill_abandoned_reminder_2` · Category: utility

**English**
> {{1}}, this is the last reminder: your order {{2}} will be cancelled soon if
> payment is not received. Reply YES to keep it, or CANCEL to release it.
> Need help? Reply SUPPORT.

**Roman Urdu**
> {{1}}, yeh aakhri reminder hai: payment na milne par aap ka order {{2}}
> cancel ho jayega. YES likhein ya CANCEL.

**Urdu**
> {{1}}، یہ آخری یاد دہانی ہے: ادائیگی نہ ملنے پر آپ کا آرڈر {{2}} منسوخ ہو
> جائے گا۔ جاری رکھنے کے لیے YES لکھیں۔

## 3. Renewal reminder (7d / 3d / 1d)

Name: `zenskill_renewal_reminder` · Category: utility

**English**
> Assalam-o-Alaikum {{1}}! Your {{2}} plan renews on {{3}} (PKR {{4}}).
> Reply RENEW to continue without interruption, or PLANS to change your plan.

**Roman Urdu**
> Assalam-o-Alaikum {{1}}! Aap ka {{2}} plan {{3}} ko renew hoga (PKR {{4}}).
> RENEW likhein ya PLANS.

**Urdu**
> السلام علیکم {{1}}! آپ کا {{2}} پلان {{3}} کو تجدید ہوگا (روپے {{4}})۔
> جاری رکھنے کے لیے RENEW لکھیں۔

## 4. Payment confirmation

Name: `zenskill_payment_confirmation` · Category: utility

**English**
> Shukriya {{1}}! We received PKR {{2}} for order {{3}}. Your payment is
> confirmed and your order is being prepared. — ZenSkil Hub

**Roman Urdu**
> Shukriya {{1}}! Order {{3}} ke liye PKR {{2}} mil gaye hain. Payment
> confirm ho gayi hai.

**Urdu**
> شکریہ {{1}}! آرڈر {{3}} کے لیے روپے {{2}} موصول ہو گئے ہیں۔ ادائیگی کی
> تصدیق ہو گئی ہے۔

## 5. Support follow-up

Name: `zenskill_support_followup` · Category: utility

**English**
> Assalam-o-Alaikum {{1}}! Following up on your ticket {{2}} — our team is
> on it. Reply here if you need anything else. — ZenSkil Hub Support

**Roman Urdu**
> Assalam-o-Alaikum {{1}}! Aap ki ticket {{2}} par hamari team kaam kar rahi
> hai. Mazeed madad chahiye to yahin reply karein.

**Urdu**
> السلام علیکم {{1}}! آپ کی ٹکٹ {{2}} پر ہماری ٹیم کام کر رہی ہے۔ مزید مدد
> درکار ہو تو یہیں جواب دیں۔

## 6. Order fulfilled (Phase 8)

> Sent ONLY when a fulfillment task reaches COMPLETED — i.e. only after the
> admin has actually delivered the service. The backend queues this from a
> single place (`FulfillmentService.completeTask`); no other flow may send a
> delivery message. Variables: {{1}} order number, {{2}} product name,
> {{3}} plan name, {{4}} expiry date (YYYY-MM-DD).

Name: `order_fulfilled` · Category: utility (owner-editable via
`system_settings` key `templates.order_fulfilled`)

**English**
> Assalam-o-Alaikum {{1}}! Your {{2}} ({{3}}) is ready — order {{1}} has been
> delivered. It stays active until {{4}}. Reply here if you need help. — ZenSkil Hub

**Roman Urdu**
> Assalam-o-Alaikum {{1}}! Aap ka {{2}} ({{3}}) ready hai — order {{1}}
> deliver ho gaya hai. Ye {{4}} tak active rahega. Madad chahiye to yahin
> reply karein. — ZenSkil Hub

**Urdu**
> السلام علیکم {{1}}! آپ کا {{2}} ({{3}}) تیار ہے — آرڈر {{1}} ڈیلیور کر دیا
> گیا ہے۔ یہ {{4}} تک فعال رہے گا۔ مدد درکار ہو تو یہیں جواب دیں۔

---

**Notes for the owner**
- Submit all six templates in Meta WhatsApp Manager before go-live.
- Keep each template's variables in the same order as the backend sends
  them (see `backend/src/automation/automation.service.ts`).
- Never add marketing copy to utility templates — Meta rejects those.
- Marketing campaigns are out of scope for v1.
