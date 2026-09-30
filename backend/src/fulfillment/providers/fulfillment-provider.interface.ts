import { FulfillmentTask } from '@prisma/client';

export interface FulfillmentResult {
  /** True when a human must finish the job (day-one manual provider). */
  requiresManualAction: boolean;
  detail?: string;
  resultPayload?: unknown;
}

// Fulfillment provider abstraction. Day one ships the manual provider: the
// task waits in the admin queue until staff completes it. API providers
// (account provisioning etc.) implement execute() later.
export interface FulfillmentProvider {
  readonly name: string;
  execute(task: FulfillmentTask): Promise<FulfillmentResult>;
}

export class ManualFulfillmentProvider implements FulfillmentProvider {
  readonly name = 'manual';

  async execute(): Promise<FulfillmentResult> {
    return {
      requiresManualAction: true,
      detail: 'Manual fulfillment: an admin must deliver the service and complete the task.',
    };
  }
}
