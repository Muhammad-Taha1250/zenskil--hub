import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { CustomerState, Language } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService, StateTransitionActor, isUniqueViolation } from '../customers/customers.service';
import { OrdersService } from '../orders/orders.service';
import { CatalogService } from '../catalog/catalog.service';
import { PaymentsService } from '../payments/payments.service';
import { AiService } from '../ai/ai.service';
import { SupportService } from '../support/support.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { InboundMessage } from '../whatsapp/whatsapp-client.interface';
import { ProofStorageService } from '../proofs/proof-storage.service';

type Lang = 'en' | 'roman' | 'ur';

function langOf(customer: { language: Language }): Lang {
  return customer.language === 'URDU' ? 'ur' : customer.language === 'ROMAN_URDU' ? 'roman' : 'en';
}

const T = {
  greeting: {
    en: (name?: string | null) =>
      `Assalam-o-Alaikum${name ? ` ${name}` : ''}! Welcome to ZenSkil Hub.\n\n1. View plans & prices\n2. My orders\n3. Talk to support\n\nReply with a number.`,
    roman: (name?: string | null) =>
      `Assalam-o-Alaikum${name ? ` ${name}` : ''}! ZenSkil Hub mein khush aamdeed.\n\n1. Plans aur qeematain dekhein\n2. Mere orders\n3. Support se baat karein\n\nNumber likh kar bhejein.`,
    ur: (name?: string | null) =>
      `السلام علیکم${name ? ` ${name}` : ''}! زین اسکل ہب میں خوش آمدید۔\n\n1. پلانز اور قیمتیں دیکھیں\n2. میرے آرڈرز\n3. سپورٹ سے بات کریں\n\nنمبر لکھ کر بھیجیں۔`,
  },
  chooseProduct: {
    en: 'Please choose a product (reply with the number):',
    roman: 'Product muntakhib karein (number likhein):',
    ur: 'پروڈکٹ منتخب کریں (نمبر لکھیں):',
  },
  choosePlan: {
    en: 'Choose a plan (reply with the number). Prices are in PKR:',
    roman: 'Plan muntakhib karein (number likhein). Qeematain PKR mein hain:',
    ur: 'پلان منتخب کریں (نمبر لکھیں)۔ قیمتیں روپے میں ہیں:',
  },
  askName: {
    en: 'Please tell me your full name to continue with the order.',
    roman: 'Order jari rakhne ke liye apna poora naam batayein.',
    ur: 'آرڈر جاری رکھنے کے لیے اپنا پورا نام بتائیں۔',
  },
  invalidChoice: {
    en: 'Please reply with one of the numbers shown above.',
    roman: 'Upar diye gaye numbers mein se koi ek likh kar bhejein.',
    ur: 'اوپر دیے گئے نمبروں میں سے کوئی ایک لکھ کر بھیجیں۔',
  },
  orderSummary: {
    en: (n: string, plan: string, total: string) =>
      `Order summary:\nOrder: ${n}\nPlan: ${plan}\nTotal: PKR ${total}\n\nReply YES to confirm, or NO to cancel.`,
    roman: (n: string, plan: string, total: string) =>
      `Order ki tafseel:\nOrder: ${n}\nPlan: ${plan}\nTotal: PKR ${total}\n\nConfirm karne ke liye YES likhein, cancel ke liye NO.`,
    ur: (n: string, plan: string, total: string) =>
      `آرڈر کی تفصیل:\nآرڈر: ${n}\nپلان: ${plan}\nکل: PKR ${total}\n\nتصدیق کے لیے YES لکھیں، منسوخی کے لیے NO۔`,
  },
  orderCancelled: {
    en: 'Your order has been cancelled. Reply 1 any time to see plans again.',
    roman: 'Aapka order cancel kar diya gaya. Plans dekhne ke liye 1 likhein.',
    ur: 'آپ کا آرڈر منسوخ کر دیا گیا۔ پلانز دیکھنے کے لیے 1 لکھیں۔',
  },
  paymentInstructions: {
    en: (total: string, details: string, deadline: string) =>
      `Please transfer PKR ${total} to:\n${details}\n\nThen send a screenshot of the transfer here.\nPayment deadline: ${deadline}`,
    roman: (total: string, details: string, deadline: string) =>
      `Barahe karam PKR ${total} yahan transfer karein:\n${details}\n\nPhir transfer ka screenshot yahin bhejein.\nAakhri tareekh: ${deadline}`,
    ur: (total: string, details: string, deadline: string) =>
      `براہ کرم PKR ${total} یہاں منتقل کریں:\n${details}\n\nپھر منتقلی کا اسکرین شاٹ یہیں بھیجیں۔\nآخری تاریخ: ${deadline}`,
  },
  proofReceived: {
    en: 'Screenshot received. Our team will verify your payment and confirm here. This usually takes a few hours.',
    roman: 'Screenshot mil gaya. Hamari team aapki payment verify karke yahin confirm karegi. Aam tor par chand ghante lagte hain.',
    ur: 'اسکرین شاٹ مل گیا۔ ہماری ٹیم آپ کی ادائیگی کی تصدیق کر کے یہیں بتائے گی۔ عام طور پر چند گھنٹے لگتے ہیں۔',
  },
  proofRejectedFormat: {
    en: 'Please send the transfer screenshot as an image.',
    roman: 'Barahe karam transfer ka screenshot tasveer ke tor par bhejein.',
    ur: 'براہ کرم منتقلی کا اسکرین شاٹ تصویر کے طور پر بھیجیں۔',
  },
  askScreenshot: {
    en: 'Once you have transferred, please send the screenshot here so we can verify it.',
    roman: 'Transfer ke baad screenshot yahin bhejein taake hum verify kar sakein.',
    ur: 'منتقلی کے بعد اسکرین شاٹ یہیں بھیجیں تاکہ ہم تصدیق کر سکیں۔',
  },
  underReview: {
    en: 'Your payment is under review. We will confirm here as soon as it is verified.',
    roman: 'Aapki payment review mein hai. Verify hote hi yahin confirm karenge.',
    ur: 'آپ کی ادائیگی زیرِ جائزہ ہے۔ تصدیق ہوتے ہی یہیں بتائیں گے۔',
  },
  optedOut: {
    en: 'You have been unsubscribed. Reply START any time to resubscribe.',
    roman: 'Aap unsubscribe ho gaye. Dobara shamil hone ke liye START likhein.',
    ur: 'آپ ان سبسکرائب ہو گئے۔ دوبارہ شامل ہونے کے لیے START لکھیں۔',
  },
  optedIn: {
    en: 'You are subscribed again. Welcome back!',
    roman: 'Aap dobara subscribe ho gaye. Khush aamdeed!',
    ur: 'آپ دوبارہ سبسکرائب ہو گئے۔ خوش آمدید!',
  },
  supportAck: {
    en: 'Noted — a team member will reply here shortly.',
    roman: 'Note kar liya — team ka numainida jald yahin jawab dega.',
    ur: 'نوٹ کر لیا — ٹیم کا نمائندہ جلد یہیں جواب دے گا۔',
  },
  noOrders: {
    en: 'You have no orders yet. Reply 1 to see plans.',
    roman: 'Aapke koi orders nahi hain. Plans ke liye 1 likhein.',
    ur: 'آپ کے کوئی آرڈرز نہیں ہیں۔ پلانز کے لیے 1 لکھیں۔',
  },
  // Deterministic menu fallback (Phase 6): when the AI cannot handle a
  // message, the customer still gets the always-working menu options.
  menuHint: {
    en: 'You can also reply with a number:\n1. View plans & prices\n2. My orders\n3. Talk to support',
    roman: 'Aap number bhi likh kar bhej sakte hain:\n1. Plans aur qeematain dekhein\n2. Mere orders\n3. Support se baat karein',
    ur: 'آپ نمبر بھی لکھ کر بھیج سکتے ہیں:\n1۔ پلانز اور قیمتیں دیکھیں\n2۔ میرے آرڈرز\n3۔ سپورٹ سے بات کریں',
  },
};

// Conversation/menu engine (spec §43/§44). Deterministic flows for ordering,
// payment proof, and support — the AI only handles free-text questions inside
// conversational states and never drives money movement.
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
    private readonly catalog: CatalogService,
    private readonly payments: PaymentsService,
    private readonly ai: AiService,
    private readonly support: SupportService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsapp: WhatsappService,
    private readonly proofs: ProofStorageService,
  ) {}

  async handleInbound(msg: InboundMessage): Promise<void> {
    const customer = await this.customers.findOrCreateByWhatsapp(msg.from);
    const session = await this.customers.getOrCreateSession(customer.id);

    // Dedupe: Meta may redeliver the same webhook. Create-first on the
    // unique whatsapp_message_id makes the dedupe atomic — concurrent
    // redeliveries race on the constraint and exactly one wins; the loser
    // returns silently instead of double-processing.
    try {
      await this.prisma.message.create({
        data: {
          sessionId: session.id,
          direction: 'INBOUND',
          messageType: msg.type === 'image' ? 'IMAGE' : msg.type === 'button_reply' || msg.type === 'list_reply' ? 'BUTTON' : 'TEXT',
          bodyText: (msg.text ?? msg.caption ?? `[${msg.type}]`).slice(0, 4000),
          whatsappMessageId: msg.providerMessageId,
          status: 'DELIVERED',
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return; // duplicate delivery
      throw err;
    }
    // Refresh the 24h customer-service window.
    await this.prisma.conversationSession.update({
      where: { id: session.id },
      data: { lastInboundAt: new Date() },
    });
    await this.whatsapp.markRead(msg.providerMessageId).catch(() => undefined);

    const lang = langOf(customer);
    const actor: StateTransitionActor = { type: 'CUSTOMER', id: customer.id };

    // Opt-out/in keywords take precedence over everything.
    const opt = await this.whatsapp.handleOptKeywords(customer.id, msg.text);
    if (opt === 'opted_out') {
      await this.reply(session.id, customer, T.optedOut[lang], 'transactional');
      return;
    }
    if (opt === 'opted_in') {
      await this.reply(session.id, customer, T.optedIn[lang], 'transactional');
      await this.sendMainMenu(session.id, customer);
      return;
    }

    try {
      await this.route(session.id, customer, msg, lang, actor);
    } catch (err) {
      this.logger.error(`Conversation routing failed: ${err instanceof Error ? err.message : err}`);
      await this.audit.log({
        actorType: 'SYSTEM', action: 'conversation.routing_failed',
        entityType: 'customer', entityId: customer.id,
        after: { error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' },
      });
      // Deterministic fallback: never leave the customer hanging.
      await this.reply(session.id, customer, T.supportAck[lang], 'transactional').catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- routing

  private async route(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    msg: InboundMessage,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    // Image = payment proof when a payment is pending.
    if (msg.type === 'image' && msg.mediaId) {
      if (customer.state === 'AWAITING_PAYMENT' || customer.state === 'PAYMENT_PROCESSING') {
        await this.handleProofImage(sessionId, customer, msg, lang);
        return;
      }
      await this.reply(sessionId, customer, T.proofRejectedFormat[lang], 'transactional');
      return;
    }

    // Interactive button/list replies.
    if ((msg.type === 'button_reply' || msg.type === 'list_reply') && msg.buttonId) {
      await this.handleButton(sessionId, customer, msg.buttonId, lang, actor);
      return;
    }

    const text = (msg.text ?? '').trim();

    switch (customer.state) {
      case 'NEW':
        await this.customers.transitionState(customer.id, 'BROWSING', actor);
        await this.sendMainMenu(sessionId, { ...customer, state: 'BROWSING' });
        return;
      case 'BROWSING':
        await this.handleBrowsing(sessionId, customer, text, lang, actor);
        return;
      case 'SELECTING_PRODUCT':
        await this.handleProductChoice(sessionId, customer, text, lang, actor);
        return;
      case 'SELECTING_PLAN':
        await this.handlePlanChoice(sessionId, customer, text, lang, actor);
        return;
      case 'WAITING_FOR_CUSTOMER_DETAILS':
        await this.handleNameCapture(sessionId, customer, text, lang, actor);
        return;
      case 'ORDER_CREATED':
        await this.handleOrderConfirmation(sessionId, customer, text, lang, actor);
        return;
      case 'AWAITING_PAYMENT':
        if (/^(paid|done|sent|transfer(ed|red)?|bhej ?diya|ho ?gaya|kar ?diya)$/i.test(text)) {
          await this.reply(sessionId, customer, T.askScreenshot[lang], 'transactional');
        } else {
          await this.aiAssist(sessionId, customer, text, lang);
        }
        return;
      case 'PAYMENT_PROCESSING':
        await this.reply(sessionId, customer, T.underReview[lang], 'transactional');
        return;
      case 'SUPPORT_REQUIRED':
        await this.aiAssist(sessionId, customer, text, lang);
        return;
      default:
        // FULFILLMENT_*, ACTIVE, EXPIRING_SOON, EXPIRED, etc: AI answers questions.
        await this.aiAssist(sessionId, customer, text, lang);
    }
  }

  private async handleButton(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    buttonId: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const [kind, value] = buttonId.split(':');
    if (kind === 'menu' && value === 'plans') {
      await this.showProducts(sessionId, customer, lang, actor);
    } else if (kind === 'menu' && value === 'orders') {
      await this.showOrders(sessionId, customer, lang);
    } else if (kind === 'menu' && value === 'support') {
      await this.requestSupport(sessionId, customer, lang, actor, 'Customer tapped support');
    } else if (kind === 'product' && value) {
      await this.showPlans(sessionId, customer, value, lang, actor);
    } else if (kind === 'plan' && value) {
      await this.selectPlan(sessionId, customer, value, lang, actor);
    } else if (kind === 'confirm' && value === 'order') {
      await this.confirmDraftOrder(sessionId, customer, lang, actor);
    } else if (kind === 'cancel' && value === 'order') {
      await this.cancelDraftOrder(sessionId, customer, lang, actor);
    } else {
      await this.sendMainMenu(sessionId, customer);
    }
  }

  // ------------------------------------------------------------------ menus

  private async sendMainMenu(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
  ): Promise<void> {
    await this.reply(sessionId, customer, T.greeting[langOf(customer)](customer.name), 'transactional');
  }

  private async handleBrowsing(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    text: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const t = text.toLowerCase();
    if (t === '1' || t.includes('plan') || t.includes('qeemat') || t.includes('price')) {
      await this.showProducts(sessionId, customer, lang, actor);
    } else if (t === '2' || t.includes('order')) {
      await this.showOrders(sessionId, customer, lang);
    } else if (t === '3' || t.includes('support') || t.includes('human') || t.includes('insan')) {
      await this.requestSupport(sessionId, customer, lang, actor, text);
    } else if (t === 'hi' || t === 'hello' || t === 'salam' || t === 'assalam') {
      await this.sendMainMenu(sessionId, customer);
    } else {
      await this.aiAssist(sessionId, customer, text, lang);
    }
  }

  private async showProducts(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const products = await this.catalog.listProducts(true);
    if (products.length === 0) {
      await this.requestSupport(sessionId, customer, lang, actor, 'No active products');
      return;
    }
    if (customer.state !== 'SELECTING_PRODUCT') {
      await this.customers.transitionState(customer.id, 'SELECTING_PRODUCT', actor);
    }
    const lines = products.map((p, i) => `${i + 1}. ${p.name}`);
    await this.customers.updateSessionContext(sessionId, {
      productOptions: products.map((p) => p.slug),
    });
    await this.reply(sessionId, customer, `${T.chooseProduct[lang]}\n${lines.join('\n')}`, 'transactional');
  }

  private async handleProductChoice(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    text: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const ctx = await this.customers.getSessionContext(sessionId);
    const options = (ctx.productOptions as string[] | undefined) ?? [];
    const idx = parseInt(text.trim(), 10) - 1;
    const slug = options[idx];
    if (!slug) {
      await this.reply(sessionId, customer, T.invalidChoice[lang], 'transactional');
      return;
    }
    await this.showPlans(sessionId, customer, slug, lang, actor);
  }

  private async showPlans(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    productSlug: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const product = await this.catalog.getProduct(productSlug);
    const plans = product.plans.filter((p) => p.isActive);
    if (plans.length === 0) {
      await this.requestSupport(sessionId, customer, lang, actor, `No active plans for ${productSlug}`);
      return;
    }
    await this.customers.transitionState(customer.id, 'SELECTING_PLAN', actor);
    await this.customers.updateSessionContext(sessionId, {
      productSlug,
      planOptions: plans.map((p) => p.id),
    });
    const lines = plans.map(
      (p, i) => `${i + 1}. ${p.name} — PKR ${(p.pricePaisa / 100).toLocaleString('en-PK')}`,
    );
    await this.reply(
      sessionId, customer,
      `${product.name}\n${T.choosePlan[lang]}\n${lines.join('\n')}`,
      'transactional',
    );
  }

  private async handlePlanChoice(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    text: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const ctx = await this.customers.getSessionContext(sessionId);
    const options = (ctx.planOptions as string[] | undefined) ?? [];
    const idx = parseInt(text.trim(), 10) - 1;
    const planId = options[idx];
    if (!planId) {
      await this.reply(sessionId, customer, T.invalidChoice[lang], 'transactional');
      return;
    }
    await this.selectPlan(sessionId, customer, planId, lang, actor);
  }

  private async selectPlan(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    planId: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    await this.catalog.getSellablePlan(planId); // throws if not sellable
    await this.customers.updateSessionContext(sessionId, { planId });
    if (!customer.name) {
      await this.customers.transitionState(customer.id, 'WAITING_FOR_CUSTOMER_DETAILS', actor);
      await this.reply(sessionId, customer, T.askName[lang], 'transactional');
      return;
    }
    await this.createDraftAndSummarize(sessionId, customer, planId, lang, actor);
  }

  private async handleNameCapture(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    text: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const name = text.trim().slice(0, 120);
    if (name.length < 2) {
      await this.reply(sessionId, customer, T.askName[lang], 'transactional');
      return;
    }
    await this.customers.updateCustomer(customer.id, { name }, actor);
    const ctx = await this.customers.getSessionContext(sessionId);
    const planId = ctx.planId as string | undefined;
    if (!planId) {
      await this.sendMainMenu(sessionId, { ...customer, name });
      return;
    }
    await this.createDraftAndSummarize(sessionId, { ...customer, name }, planId, lang, actor);
  }

  private async createDraftAndSummarize(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    planId: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const order = await this.orders.createDraftOrder(customer.id, { planId }, actor);
    await this.customers.transitionState(customer.id, 'ORDER_CREATED', actor);
    await this.customers.updateSessionContext(sessionId, { draftOrderId: order.id });
    const plan = await this.catalog.getPlan(planId);
    await this.reply(
      sessionId, customer,
      T.orderSummary[lang](order.orderNumber, plan.name, (order.totalPaisa / 100).toLocaleString('en-PK')),
      'transactional',
    );
  }

  private async handleOrderConfirmation(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    text: string,
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const t = text.trim().toLowerCase();
    if (t === 'yes' || t === 'y' || t === 'han' || t === 'haa' || t === 'ji' || t === 'jee') {
      await this.confirmDraftOrder(sessionId, customer, lang, actor);
    } else if (t === 'no' || t === 'n' || t === 'nahi' || t === 'nahin') {
      await this.cancelDraftOrder(sessionId, customer, lang, actor);
    } else {
      const ctx = await this.customers.getSessionContext(sessionId);
      const orderId = ctx.draftOrderId as string | undefined;
      if (orderId) {
        const order = await this.orders.getOrder(orderId);
        const plan = await this.catalog.getPlan(order.items[0]?.planId ?? '');
        await this.reply(
          sessionId, customer,
          T.orderSummary[lang](order.orderNumber, plan.name, (order.totalPaisa / 100).toLocaleString('en-PK')),
          'transactional',
        );
      } else {
        await this.sendMainMenu(sessionId, customer);
      }
    }
  }

  private async confirmDraftOrder(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const ctx = await this.customers.getSessionContext(sessionId);
    const orderId = ctx.draftOrderId as string | undefined;
    if (!orderId) {
      await this.sendMainMenu(sessionId, customer);
      return;
    }
    const { order, payment } = await this.orders.confirmOrder(orderId, actor);
    await this.customers.transitionState(customer.id, 'AWAITING_PAYMENT', actor);
    // Single source of truth for what the customer must do to pay (Phase 7):
    // amount, owner-configured transfer details, deadline, proof guidance.
    const instructions = await this.payments.getPaymentInstructions(payment.id);
    const deadline = instructions.deadline
      ? instructions.deadline.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
      : '—';
    await this.reply(
      sessionId, customer,
      T.paymentInstructions[lang]((order.totalPaisa / 100).toLocaleString('en-PK'), instructions.transferDetails, deadline),
      'transactional',
    );
  }

  private async cancelDraftOrder(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    lang: Lang,
    actor: StateTransitionActor,
  ): Promise<void> {
    const ctx = await this.customers.getSessionContext(sessionId);
    const orderId = ctx.draftOrderId as string | undefined;
    if (orderId) {
      await this.orders.cancelOrder(orderId, actor, 'Cancelled by customer on WhatsApp');
    }
    await this.customers.transitionState(customer.id, 'CANCELLED', actor);
    await this.customers.transitionState(customer.id, 'BROWSING', actor);
    await this.customers.updateSessionContext(sessionId, { draftOrderId: null, planId: null });
    await this.reply(sessionId, customer, T.orderCancelled[lang], 'transactional');
  }

  // ------------------------------------------------------------------ proof

  private async handleProofImage(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    msg: InboundMessage,
    lang: Lang,
  ): Promise<void> {
    const ctx = await this.customers.getSessionContext(sessionId);
    const orderId =
      (ctx.draftOrderId as string | undefined) ??
      (await this.latestAwaitingOrderId(customer.id));
    if (!orderId) {
      await this.reply(sessionId, customer, T.proofRejectedFormat[lang], 'transactional');
      return;
    }
    const payment = await this.payments.getActivePaymentForOrder(orderId);
    if (!payment) {
      await this.reply(sessionId, customer, T.underReview[lang], 'transactional');
      return;
    }

    // Download the image and store it in private proof storage; the storage
    // key (never a hot-linked Meta CDN URL) becomes the durable proof
    // reference, and sha256 guarantees integrity.
    let storageKey: string | undefined;
    let proofHash: string | undefined;
    try {
      const { data, mimeType } = await this.whatsapp.downloadMedia(msg.mediaId!);
      const stored = await this.proofs.store(payment.id, data, mimeType);
      storageKey = stored.storageKey;
      proofHash = stored.sha256;
    } catch (err) {
      this.logger.warn(`Proof download/store failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!storageKey) {
      await this.reply(sessionId, customer, T.proofRejectedFormat[lang], 'transactional');
      return;
    }

    await this.payments.submitProof(
      payment.id,
      { storageKey, proofHash },
      { type: 'CUSTOMER', id: customer.id },
    );
    await this.customers.transitionState(customer.id, 'PAYMENT_PROCESSING', { type: 'CUSTOMER', id: customer.id });
    await this.reply(sessionId, customer, T.proofReceived[lang], 'transactional');
  }

  private async latestAwaitingOrderId(customerId: string): Promise<string | null> {
    const order = await this.prisma.order.findFirst({
      where: { customerId, status: { in: ['AWAITING_PAYMENT', 'PAYMENT_PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return order?.id ?? null;
  }

  // ------------------------------------------------------------------ misc

  private async showOrders(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    lang: Lang,
  ): Promise<void> {
    const { items } = await this.orders.listOrders({ customerId: customer.id, pageSize: 5 });
    if (items.length === 0) {
      await this.reply(sessionId, customer, T.noOrders[lang], 'transactional');
      return;
    }
    const lines = items.map(
      (o) => `${o.orderNumber} — ${o.status} — PKR ${(o.totalPaisa / 100).toLocaleString('en-PK')}`,
    );
    await this.reply(sessionId, customer, lines.join('\n'), 'transactional');
  }

  private async requestSupport(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    lang: Lang,
    actor: StateTransitionActor,
    reason: string,
  ): Promise<void> {
    const open = await this.support.findOpenForCustomer(customer.id);
    if (open.length === 0) {
      await this.support.createTicket(
        customer.id,
        { subject: 'Support requested on WhatsApp', description: reason, priority: 'MEDIUM', authorType: 'CUSTOMER' },
        actor,
      ).catch(() => undefined);
    }
    await this.customers.transitionState(customer.id, 'SUPPORT_REQUIRED', actor).catch(() => undefined);
    await this.reply(sessionId, customer, T.supportAck[lang], 'transactional');
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'conversation.support_requested', entityType: 'customer', entityId: customer.id,
      after: { reason: reason.slice(0, 300) },
    });
  }

  private async aiAssist(
    sessionId: string,
    customer: { id: string; state: CustomerState; whatsappNumber: string; language: Language; name: string | null },
    text: string,
    lang: Lang,
  ): Promise<void> {
    if (!text.trim()) return;
    const history = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { direction: true, bodyText: true },
    });
    const reply = await this.ai.generateReply({
      customerId: customer.id,
      sessionId,
      messageText: text,
      history: history.reverse().map((h: { direction: string; bodyText: string | null }) => ({
        role: h.direction === 'INBOUND' ? ('customer' as const) : ('assistant' as const),
        text: h.bodyText ?? '',
      })),
    });
    // Phase 6: on AI failure the deterministic menu flow takes over — the
    // customer is never left with a dead end.
    const body = reply.fallback ? `${reply.replyText}\n\n${T.menuHint[lang]}` : reply.replyText;
    await this.reply(sessionId, customer, body, 'transactional');
  }

  private async reply(
    sessionId: string,
    customer: { id: string; whatsappNumber: string },
    body: string,
    kind: 'transactional' | 'template',
  ): Promise<void> {
    await this.whatsapp.sendText(sessionId, customer.id, customer.whatsappNumber, { body, kind });
  }
}
