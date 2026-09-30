// Prompt-injection and manipulation detection (spec §54).
// Scans incoming customer text for instruction-override, role-play, secret
// extraction, and financial-manipulation patterns in English, Roman Urdu and
// Urdu script. On a hit the AI must NOT act on the message — it escalates.

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // instruction override
  { name: 'ignore_instructions', re: /ignor(e|ing)\s+(all\s+|previous\s+|prior\s+|your\s+)?(instructions|instruction|rules|guidelines)/i },
  { name: 'disregard', re: /disregard\s+(all\s+|previous\s+|your\s+)?(instructions|rules|orders)/i },
  { name: 'forget_instructions', re: /forget\s+(all\s+|your\s+|previous\s+|prior\s+)*(instructions|rules|training|guidelines)/i },
  { name: 'override', re: /\b(system|developer)\s+(prompt|message|instruction)/i },
  { name: 'new_role', re: /you are now\s+(a|an|not)/i },
  { name: 'dan_mode', re: /\bDAN\b|\bjailbreak\b|\bdo anything now\b/i },
  { name: 'reveal_prompt', re: /(reveal|show|print|repeat|disclose).{0,40}(system prompt|your prompt|instructions|training data)/i },
  { name: 'reveal_secrets', re: /(api key|secret key|password|token|credential).{0,30}(show|reveal|tell|give|what is)/i },
  // roman urdu / urdu instruction override
  { name: 'ignore_ur', re: /(pichli|purani)\s+(hidayat|hidayaat|instructions?)\s+(bhool|bhool jao|ignore)/i },
  { name: 'ignore_ur_script', re: /پچھلی\s+ہدایات\s+بھول/i },
  { name: 'prompt_ur', re: /(system prompt|apna prompt)\s*(batao|dikhao|bataein)/i },
  // financial manipulation — things the AI must never promise/do
  { name: 'approve_refund', re: /(approve|do|give|process).{0,30}(my\s+)?refund/i },
  { name: 'refund_order_demand', re: /\brefund\b.{0,20}\b(my|the)\s+order\b/i },
  { name: 'mark_paid', re: /(mark|declare|confirm).{0,30}(payment|order).{0,20}(paid|complete|successful|success|done|verified)/i },
  { name: 'fake_payment', re: /(without (paying|payment)|free (access|course|plan)|bypass (payment|paywall))/i },
  { name: 'discount_demand', re: /(give|apply).{0,20}(discount|coupon|promo)/i },
  { name: 'price_change', re: /(change|lower|reduce).{0,20}price/i },
  { name: 'delete_account', re: /(delete|remove).{0,20}(my\s+)?account/i },
  // affiliation claims
  { name: 'affiliation', re: /\b(say|claim|pretend|tell).{0,40}(udemy|coursera|envato).{0,20}(partner|official|affiliated)/i },
  // credential phishing via social engineering the bot
  { name: 'extract_cnic', re: /(give|show|tell).{0,20}(other|someone).{0,20}(cnic|card number|password)/i },
];

export interface InjectionScanResult {
  hit: boolean;
  pattern?: string;
}

/** Returns the first matching manipulation pattern, if any. */
export function scanForInjection(text: string): InjectionScanResult {
  if (!text) return { hit: false };
  for (const p of PATTERNS) {
    if (p.re.test(text)) return { hit: true, pattern: p.name };
  }
  return { hit: false };
}

// Output-side guard: the model's final text must never contain these.
const FORBIDDEN_OUTPUT: Array<{ name: string; re: RegExp }> = [
  { name: 'refund_promise', re: /(your refund (has been|is) (approved|processed|done))|(refund approved)/i },
  { name: 'paid_promise', re: /(payment (marked|confirmed) (as )?paid)|(order (is now )?paid)/i },
  { name: 'discount_promise', re: /(discount (applied|given))|(promo code (created|for you))/i },
  { name: 'affiliation_claim', re: /(we are|i am).{0,30}(udemy|coursera|envato).{0,20}(partner|official|affiliated)/i },
  { name: 'credential_request', re: /(send|share|provide).{0,20}(your )?(cnic|password|card number|otp|pin)/i },
];

export function scanOutput(text: string): InjectionScanResult {
  if (!text) return { hit: false };
  for (const p of FORBIDDEN_OUTPUT) {
    if (p.re.test(text)) return { hit: true, pattern: p.name };
  }
  return { hit: false };
}
