// Dispatch policy for the n8n notification-dispatcher workflow.
//
// This is the single, pure codification of the window/template/opt-in rules
// that the backend already enforces in whatsapp.service.ts:
//   - free-form text / interactive buttons / media: allowed ONLY inside the
//     24h customer-service window (Meta rejects them outside it). Opt-in is
//     irrelevant — a customer mid-conversation is, by definition, reachable.
//   - approved templates: the ONLY channel outside the 24h window, and they
//     additionally require opt-in (STOP silences them permanently).
//   - marketing-type nudges (abandoned/renewal reminders): ALWAYS templates,
//     never free-form — enforced by the reminder services, which only call
//     sendTemplateNotification().
//
// The n8n workflow is a thin dispatcher: it asks the backend for candidates
// and calls backend endpoints to send. The backend applies this policy, so the
// workflow cannot accidentally violate window or opt-in rules.

export type OutboundChannel = 'free-form' | 'template';

export type BlockReason = 'outside_24h_window' | 'not_opted_in';

export type DispatchDecision =
  | { allowed: true; channel: OutboundChannel }
  | { allowed: false; reason: BlockReason };

export interface DispatchContext {
  /** Which channel the caller wants to use. */
  channel: OutboundChannel;
  /** True when the customer sent a message within the last 24h. */
  inWindow: boolean;
  /** True when the customer has not opted out (STOP). */
  optedIn: boolean;
}

/**
 * Pure decision function: given the channel, window state and opt-in state,
 * decide whether the send may proceed. Total order of checks:
 *   1. free-form requires the 24h window;
 *   2. templates require opt-in (in or out of the window).
 */
export function resolveDispatchChannel(ctx: DispatchContext): DispatchDecision {
  if (ctx.channel === 'free-form') {
    return ctx.inWindow
      ? { allowed: true, channel: 'free-form' }
      : { allowed: false, reason: 'outside_24h_window' };
  }
  return ctx.optedIn
    ? { allowed: true, channel: 'template' }
    : { allowed: false, reason: 'not_opted_in' };
}
