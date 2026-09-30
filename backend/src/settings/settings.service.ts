import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { StateTransitionActor } from '../customers/customers.service';

const KARACHI_TZ = 'Asia/Karachi';

// System settings (key → JSON value) and business hours. Settings are the
// runtime configuration the owner edits in the admin panel — reminder
// thresholds, payment window, message copy, credential *references*.
// Raw credential values are accepted but never written to audit logs.
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!row) return fallback;
    return row.value as unknown as T;
  }

  async getAllSettings() {
    return this.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async updateSetting(key: string, value: unknown, actor: StateTransitionActor, description?: string) {
    if (!key || !/^[a-z0-9_.-]{1,100}$/i.test(key)) {
      throw new BadRequestException('Invalid setting key');
    }
    const before = await this.prisma.systemSetting.findUnique({ where: { key } });
    const updated = await this.prisma.systemSetting.upsert({
      where: { key },
      create: {
        key,
        value: value as Prisma.InputJsonValue,
        description: description ?? before?.description ?? null,
        updatedBy: actor.type === 'ADMIN' ? actor.id : null,
      },
      update: {
        value: value as Prisma.InputJsonValue,
        description: description ?? before?.description ?? null,
        updatedBy: actor.type === 'ADMIN' ? actor.id : null,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'setting.updated', entityType: 'system_setting', entityId: key,
      before: before ? { value: before.value } : null,
      after: { value },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  // ------------------------------------------------------- business hours

  async listBusinessHours() {
    return this.prisma.businessHours.findMany({ orderBy: { dayOfWeek: 'asc' } });
  }

  async upsertBusinessHours(
    dayOfWeek: number,
    data: { openTime?: string | null; closeTime?: string | null; isClosed?: boolean },
    actor: StateTransitionActor,
  ) {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new BadRequestException('dayOfWeek must be 0 (Sunday) .. 6 (Saturday)');
    }
    for (const t of [data.openTime, data.closeTime]) {
      if (t !== undefined && t !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        throw new BadRequestException(`Invalid time "${t}" — expected HH:MM`);
      }
    }
    const row = await this.prisma.businessHours.upsert({
      where: { dayOfWeek },
      create: {
        dayOfWeek,
        openTime: data.openTime ?? null,
        closeTime: data.closeTime ?? null,
        isClosed: data.isClosed ?? false,
      },
      update: {
        openTime: data.openTime ?? null,
        closeTime: data.closeTime ?? null,
        isClosed: data.isClosed ?? false,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'business_hours.updated', entityType: 'business_hours', entityId: row.id,
      after: { dayOfWeek, ...data },
      ipAddress: actor.ip ?? null,
    });
    return row;
  }

  /** Is the business open right now (Asia/Karachi)? Used for support auto-replies. */
  async isOpenAt(at: Date = new Date()): Promise<boolean> {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: KARACHI_TZ,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday'); // Sun, Mon, ...
    const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
    const nowHm = `${get('hour')}:${get('minute')}`;

    const row = await this.prisma.businessHours.findUnique({ where: { dayOfWeek } });
    if (!row || row.isClosed || !row.openTime || !row.closeTime) return false;
    // 00:00-23:59 is the all-day convention: the strict `< closeTime` check
    // would otherwise exclude the final minute (23:59) of the day.
    if (row.openTime === '00:00' && row.closeTime === '23:59') return true;
    return row.openTime <= nowHm && nowHm < row.closeTime;
  }

  // ------------------------------------------- approval side-effect handlers

  /** POLICY_CHANGE: applies an approved { settingKey, value } payload. */
  async applyPolicyChange(payload: { settingKey: string; value: unknown }, actor: StateTransitionActor) {
    if (!payload?.settingKey) throw new BadRequestException('POLICY_CHANGE payload needs settingKey');
    return this.updateSetting(payload.settingKey, payload.value, actor, 'Applied via approved policy change');
  }

  /**
   * CREDENTIAL_CHANGE: stores an approved credential *reference* (e.g. which
   * secret was rotated and where it now lives). Raw values are never logged.
   */
  async applyCredentialChange(
    payload: { settingKey: string; value: unknown; note?: string },
    actor: StateTransitionActor,
  ) {
    if (!payload?.settingKey) throw new BadRequestException('CREDENTIAL_CHANGE payload needs settingKey');
    const before = await this.prisma.systemSetting.findUnique({ where: { key: payload.settingKey } });
    await this.prisma.systemSetting.upsert({
      where: { key: payload.settingKey },
      create: {
        key: payload.settingKey,
        value: payload.value as Prisma.InputJsonValue,
        description: 'Credential reference — value stored, never logged',
        updatedBy: actor.type === 'ADMIN' ? actor.id : null,
      },
      update: {
        value: payload.value as Prisma.InputJsonValue,
        updatedBy: actor.type === 'ADMIN' ? actor.id : null,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'credential.rotated', entityType: 'system_setting', entityId: payload.settingKey,
      before: before ? { existed: true } : { existed: false },
      after: { rotated: true, note: payload.note ?? null }, // value deliberately omitted
      ipAddress: actor.ip ?? null,
    });
  }
}
