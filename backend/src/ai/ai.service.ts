import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService, StateTransitionActor } from '../customers/customers.service';
import { OrdersService } from '../orders/orders.service';
import { CatalogService } from '../catalog/catalog.service';
import { PaymentsService } from '../payments/payments.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SupportService } from '../support/support.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import {
  LlmMessage,
  LlmProvider,
} from './llm-provider.interface';
import { StubProvider } from './providers/stub.provider';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';
import { TOOL_DEFINITIONS, ToolDependencies, executeTool } from './tools';
import { scanForInjection, scanOutput } from './injection-detection';
import { redactPII } from './pii-redaction';

export type AiLanguage = 'en' | 'ur' | 'roman';

export interface AiReplyRequest {
  customerId: string;
  sessionId: string;
  messageText: string;
  history: Array<{ role: 'customer' | 'assistant'; text: string }>;
}

export interface AiReply {
  replyText: string;
  language: AiLanguage;
  escalated: boolean;
  /** True when the AI could not handle the message and a deterministic
   *  fallback was returned — the caller should offer the menu flow. */
  fallback: boolean;
  toolCalls: Array<{ name: string; ok: boolean }>;
  provider: string;
}

const MAX_TOOL_ROUNDS = 4;
const RATE_LIMIT_PER_MIN = 20;

const SYSTEM_PROMPT = `You are the ZenSkil Hub WhatsApp assistant for a learning-services business in Pakistan.
Rules you MUST follow — violating any of them is a critical failure:
1. PRICES: Quote prices ONLY from the get_plan / get_product tool results (pricePaisa / 100 = PKR). NEVER invent, estimate, round differently, or recall prices from training.
2. GROUNDING: Answer factual/policy questions ONLY from search_knowledge_base results. If the KB has no relevant answer, say you don't know and offer a human agent.
3. YOU CANNOT: approve refunds, mark payments paid, apply discounts, change prices, delete accounts, change settings, or claim partnership with Udemy, Coursera, Envato or anyone else.
4. NEVER ask for CNIC, passwords, full card numbers, OTPs, or bank credentials.
5. Keep replies SHORT (WhatsApp style): 1-3 short sentences or a compact list. No long paragraphs.
6. If the customer is upset, confused, or asks for a person: call request_human_agent.
7. If a tool call fails, do not retry blindly — tell the customer simply and offer a human.
Reply in the customer's language (English, Roman Urdu, or Urdu script).`;

const FALLBACKS: Record<AiLanguage, string> = {
  en: 'Thanks for reaching out! A team member will reply here shortly.',
  roman: 'Shukriya rabta karne ka! Hamari team jald yahin jawab degi.',
  ur: 'رابطہ کرنے کا شکریہ! ہماری ٹیم جلد یہیں جواب دے گی۔',
};

const INJECTION_REPLIES: Record<AiLanguage, string> = {
  en: 'I can only help with ZenSkil Hub orders, plans and support. Connecting you to a team member now.',
  roman: 'Main sirf ZenSkil Hub ke orders, plans aur support mein madad kar sakta hoon. Team se rabta karwa raha hoon.',
  ur: 'میں صرف زین اسکل ہب کے آرڈرز، پلانز اور سپورٹ میں مدد کر سکتا ہوں۔ ٹیم سے رابطہ کروا رہا ہوں۔',
};

// The AI module is the ONLY place the LLM lives. Deterministic business logic
// never depends on model output: the model may only read through the 9 tools
// and produce reply text, which is scanned before delivery.
@Injectable()
export class AiService {
  private readonly provider: LlmProvider;
  private readonly rate = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
    private readonly catalog: CatalogService,
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly support: SupportService,
    private readonly knowledge: KnowledgeService,
  ) {
    const apiKey = this.config.get<string>('AI_API_KEY');
    const baseUrl = this.config.get<string>('AI_BASE_URL') ?? 'https://api.openai.com/v1';
    const model = this.config.get<string>('AI_MODEL') ?? 'gpt-4o-mini';
    this.provider = apiKey
      ? new OpenAICompatibleProvider(baseUrl, apiKey, model)
      : new StubProvider();
  }

  get providerName(): string {
    return this.provider.providerName;
  }

  detectLanguage(text: string): AiLanguage {
    if (/[\u0600-\u06FF]/.test(text)) return 'ur';
    const romanHints = /\b(aap|tum|kya|hai|hain|nahi|nahin|kaise|kaisa|shukriya|meherbani|paise|qimat|keemat|madad|chahiye|batao|bataein|kaun|kab|kahan|kyun)\b/i;
    if (romanHints.test(text)) return 'roman';
    return 'en';
  }

  private checkRateLimit(customerId: string): boolean {
    const now = Date.now();
    const entry = this.rate.get(customerId);
    if (!entry || now - entry.windowStart > 60_000) {
      this.rate.set(customerId, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_LIMIT_PER_MIN;
  }

  private toolDeps(): ToolDependencies {
    return {
      customers: this.customers,
      orders: this.orders,
      catalog: this.catalog,
      payments: this.payments,
      subscriptions: this.subscriptions,
      support: this.support,
      knowledge: this.knowledge,
    };
  }

  async generateReply(req: AiReplyRequest): Promise<AiReply> {
    const language = this.detectLanguage(req.messageText);
    const actor: StateTransitionActor = { type: 'AI' };
    const toolCalls: Array<{ name: string; ok: boolean }> = [];

    if (!this.checkRateLimit(req.customerId)) {
      return {
        replyText: FALLBACKS[language], language, escalated: true, fallback: true,
        toolCalls, provider: this.providerName,
      };
    }

    // 1. Injection / manipulation scan — never act on a hit.
    const injection = scanForInjection(req.messageText);
    if (injection.hit) {
      await this.audit.log({
        actorType: 'AI',
        action: 'ai.injection_blocked',
        entityType: 'customer',
        entityId: req.customerId,
        after: { pattern: injection.pattern },
      });
      await this.escalateSilently(req.customerId, `Injection pattern blocked: ${injection.pattern}`);
      return {
        replyText: INJECTION_REPLIES[language], language, escalated: true, fallback: true,
        toolCalls, provider: this.providerName,
      };
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...req.history.slice(-10).map((h) => ({
        role: (h.role === 'customer' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: h.text.slice(0, 1000),
      })),
      { role: 'user', content: req.messageText.slice(0, 2000) },
    ];

    const deps = this.toolDeps();
    const tctx = { customerId: req.customerId, actor, language: language === 'roman' ? 'en' : language };

    let finalText = '';
    let escalated = false;
    let fallback = false;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const completion = await this.provider.complete(messages, TOOL_DEFINITIONS, { maxTokens: 500 });

        if (completion.toolCalls.length === 0) {
          finalText = completion.text;
          break;
        }

        messages.push({
          role: 'assistant',
          content: completion.text,
          toolCalls: completion.toolCalls,
        });

        for (const call of completion.toolCalls) {
          let result: unknown;
          let ok = true;
          try {
            const parsedArgs = JSON.parse(call.argumentsJson || '{}');
            result = await executeTool(call.name, parsedArgs, tctx, deps);
          } catch (err) {
            ok = false;
            result = { error: err instanceof Error ? err.message : 'Tool failed' };
          }
          toolCalls.push({ name: call.name, ok });
          await this.audit.log({
            actorType: 'AI',
            action: 'ai.tool_call',
            entityType: 'customer',
            entityId: req.customerId,
            after: {
              tool: call.name, ok,
              args: redactPII(call.argumentsJson).slice(0, 500),
              result: redactPII(JSON.stringify(result)).slice(0, 1000),
            },
          });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(result).slice(0, 4000),
          });

          if (call.name === 'request_human_agent' && ok) escalated = true;
        }

        // Stub provider path: exactly one deterministic tool round; the answer
        // is rendered from the tool result and never invented.
        if (this.provider instanceof StubProvider) {
          const toolMsg = [...messages].reverse().find((m) => m.toolCalls?.length);
          const toolName = toolMsg?.toolCalls?.[0]?.name ?? 'search_knowledge_base';
          const toolResult = messages[messages.length - 1]?.content ?? 'null';
          finalText = this.answerFromToolResult(toolName, toolResult, language);
          if (finalText === '__ESCALATE__') {
            await this.escalateSilently(req.customerId, `Stub provider: no ${toolName} answer`);
            finalText = FALLBACKS[language];
            escalated = true;
            fallback = true;
          }
          break;
        }
      }
    } catch (err) {
      await this.audit.log({
        actorType: 'AI',
        action: 'ai.provider_error',
        entityType: 'customer',
        entityId: req.customerId,
        after: { error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' },
      });
      return {
        replyText: FALLBACKS[language], language, escalated: true, fallback: true,
        toolCalls, provider: this.providerName,
      };
    }

    finalText = (finalText || '').trim();

    // 2. Output guard — block forbidden promises/claims before delivery.
    const bad = scanOutput(finalText);
    if (bad.hit) {
      await this.audit.log({
        actorType: 'AI',
        action: 'ai.output_blocked',
        entityType: 'customer',
        entityId: req.customerId,
        after: { pattern: bad.pattern },
      });
      await this.escalateSilently(req.customerId, `Output guard blocked: ${bad.pattern}`);
      return {
        replyText: FALLBACKS[language], language, escalated: true, fallback: true,
        toolCalls, provider: this.providerName,
      };
    }

    // 3. Empty / "I don't know" → escalate to a human (KB-only grounding).
    if (!finalText || /i don'?t know|don'?t have (that|enough) information|not sure/i.test(finalText)) {
      await this.escalateSilently(req.customerId, 'AI had no confident answer');
      return {
        replyText: FALLBACKS[language], language, escalated: true, fallback: true,
        toolCalls, provider: this.providerName,
      };
    }

    await this.audit.log({
      actorType: 'AI',
      action: 'ai.invocation',
      entityType: 'customer',
      entityId: req.customerId,
      after: {
        provider: this.providerName,
        language,
        escalated,
        toolCalls: toolCalls.map((t) => `${t.name}:${t.ok ? 'ok' : 'fail'}`),
        replyPreview: redactPII(finalText).slice(0, 200),
      },
    });

    return { replyText: finalText, language, escalated, fallback, toolCalls, provider: this.providerName };
  }

  /** Stub-provider answering: render the single tool result, never invent. */
  private answerFromToolResult(toolName: string, toolJson: string, language: AiLanguage): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolJson);
    } catch {
      return '__ESCALATE__';
    }
    if (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
      return '__ESCALATE__'; // tool failed (e.g. order not found / not owned)
    }
    switch (toolName) {
      case 'get_plan':
        return this.answerFromPlans(parsed, language);
      case 'get_order':
        return this.answerFromOrder(parsed, language);
      case 'get_subscription_status':
        return this.answerFromSubscriptions(parsed, language);
      case 'search_knowledge_base':
      default:
        return this.answerFromKb(toolJson, language);
    }
  }

  private pkr(paisa: number): string {
    return `PKR ${(paisa / 100).toLocaleString('en-US')}`;
  }

  private answerFromPlans(parsed: unknown, language: AiLanguage): string {
    const plans = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (p): p is { name: string; durationMonths: number; pricePaisa: number } =>
        !!p && typeof p === 'object' && typeof (p as { pricePaisa?: unknown }).pricePaisa === 'number',
    );
    if (plans.length === 0) return '__ESCALATE__';
    const lines = plans.map((p) => `• ${p.name} — ${this.pkr(p.pricePaisa)}`);
    const head =
      language === 'ur' ? 'ہمارے پلانز:' :
      language === 'roman' ? 'Hamare plans:' : 'Our plans:';
    return `${head}\n${lines.join('\n')}`;
  }

  private answerFromOrder(parsed: unknown, language: AiLanguage): string {
    const o = parsed as { orderNumber?: string; status?: string; totalPaisa?: number };
    if (!o || typeof o !== 'object' || !o.orderNumber) return '__ESCALATE__';
    const status = String(o.status ?? '').replace(/_/g, ' ');
    const total = typeof o.totalPaisa === 'number' ? `, ${this.pkr(o.totalPaisa)}` : '';
    return language === 'ur'
      ? `آرڈر ${o.orderNumber}: ${status}${total}`
      : language === 'roman'
        ? `Order ${o.orderNumber}: ${status}${total}`
        : `Order ${o.orderNumber}: ${status}${total}`;
  }

  private answerFromSubscriptions(parsed: unknown, language: AiLanguage): string {
    const subs = (Array.isArray(parsed) ? parsed : []).filter(
      (s): s is { planName: string; status: string; expiresAt: string } =>
        !!s && typeof s === 'object' && typeof (s as { planName?: unknown }).planName === 'string',
    );
    if (subs.length === 0) {
      return language === 'ur'
        ? 'آپ کی کوئی فعال سبسکرپشن نہیں ہے۔'
        : language === 'roman'
          ? 'Aap ki koi active subscription nahi hai.'
          : 'You have no active subscriptions.';
    }
    const lines = subs.map((s) => {
      const exp = s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : '?';
      return `• ${s.planName} — ${s.status} (expires ${exp})`;
    });
    const head =
      language === 'ur' ? 'آپ کی سبسکرپشنز:' :
      language === 'roman' ? 'Aap ki subscriptions:' : 'Your subscriptions:';
    return `${head}\n${lines.join('\n')}`;
  }

  /** Stub-provider KB answering: first KB hit verbatim (trimmed), else escalate. */
  private answerFromKb(kbJson: string, language: AiLanguage): string {
    try {
      const hits = JSON.parse(kbJson) as Array<{ title?: string; content?: string }>;
      const best = hits.find((h) => h.content && h.content.trim().length > 20);
      if (!best?.content) return '__ESCALATE__';
      const prefix =
        language === 'ur' ? '' :
        language === 'roman' ? 'Yeh rahi maloomat: ' : '';
      return `${prefix}${best.content.trim().slice(0, 600)}`;
    } catch {
      return '__ESCALATE__';
    }
  }

  private async escalateSilently(customerId: string, reason: string): Promise<void> {
    const actor: StateTransitionActor = { type: 'AI' };
    await this.customers.transitionState(customerId, 'SUPPORT_REQUIRED', actor).catch(() => undefined);
    const open = await this.support.findOpenForCustomer(customerId);
    if (open.length === 0) {
      await this.support
        .createTicket(customerId, { subject: 'AI escalation', description: reason, priority: 'HIGH', authorType: 'SYSTEM' }, actor)
        .catch(() => undefined);
    }
  }
}
