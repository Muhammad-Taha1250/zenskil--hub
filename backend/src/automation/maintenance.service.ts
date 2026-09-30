import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { BackupConfig } from '../config/configuration';
import {
  BACKUP_UNENCRYPTED_WARNING,
  encryptedBackupStream,
  parseAgeRecipients,
} from './backup-crypto';

// Nightly database backup for the n8n db-backup workflow (Phase 5).
//
// Runs pg_dump against DATABASE_URL, streams it through gzip and — when
// BACKUP_AGE_RECIPIENTS is configured — through age encryption to every
// recipient, writing `<name>.sql.gz.age` into BACKUP_DIR (default:
// <workspace>/backups). When no recipients are configured the backup stays
// plaintext (`.sql.gz`) but a loud warning is logged AND audited (T12: never
// silently plaintext). Keeps the newest BACKUP_RETENTION_COUNT files
// (default 7) and writes an audit row.
// Only ever invoked via the OWNER/service-token automation endpoint —
// never on a customer path.
const DEFAULT_RETENTION = 7;

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async runDbBackup(): Promise<{ file: string; sizeBytes: number; durationMs: number; pruned: number; encrypted: boolean }> {
    const started = Date.now();
    const dir = process.env.BACKUP_DIR ?? join(process.cwd(), '..', 'backups');
    await fs.mkdir(dir, { recursive: true });

    // Recipients from typed config (BACKUP_AGE_RECIPIENTS, comma-separated).
    // Empty => plaintext backup + LOUD warning (logged and audited), never silent.
    const recipients =
      this.config.get<BackupConfig>('backup')?.ageRecipients ?? parseAgeRecipients(process.env.BACKUP_AGE_RECIPIENTS);
    const encrypted = recipients.length > 0;
    const ext = encrypted ? '.sql.gz.age' : '.sql.gz';
    const file = join(dir, `zenskill-backup-${stamp(new Date())}${ext}`);
    if (!encrypted) {
      this.logger.warn(BACKUP_UNENCRYPTED_WARNING);
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not configured');

    // execFile (no shell) + env passthrough: the URL never appears in logs.
    // NOTE: the close/error listeners are attached BEFORE consuming stdout —
    // for a small database pg_dump can exit before the pipeline finishes,
    // and a listener attached afterwards would miss the event and hang.
    const dump = execFile('pg_dump', ['--no-owner', '--no-acl', databaseUrl], {
      env: { ...process.env, PGAPPNAME: 'zenskill-backup' },
    });
    const exited = new Promise<void>((resolve, reject) => {
      dump.on('error', reject);
      dump.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`))));
    });
    dump.stderr?.on('data', (d: Buffer) => this.logger.debug(`pg_dump: ${d.toString().trim().slice(0, 200)}`));
    try {
      if (encrypted) {
        // pg_dump -> gzip -> age (streaming; plaintext never touches disk).
        if (!dump.stdout) throw new Error('pg_dump produced no stdout');
        const gz = createGzip();
        const encryptedOut = encryptedBackupStream(gz, recipients);
        dump.stdout.pipe(gz);
        await pipeline(await encryptedOut, createWriteStream(file));
      } else {
        await pipeline(dump.stdout!, createGzip(), createWriteStream(file));
      }
      await exited;
    } catch (err) {
      dump.kill('SIGKILL');
      await fs.rm(file, { force: true });
      throw err;
    }

    const { size } = await fs.stat(file);
    const pruned = await this.pruneOld(dir);

    await this.audit.log({
      actorType: 'SYSTEM', actorId: null,
      action: 'maintenance.db_backup',
      entityType: 'system', entityId: null,
      after: {
        file: file.split('/').pop(),
        sizeBytes: size,
        pruned,
        encrypted,
        ...(encrypted ? {} : { warning: BACKUP_UNENCRYPTED_WARNING }),
      },
      ipAddress: null,
    });
    this.logger.log(
      `Database backup written: ${file} (${size} bytes, pruned ${pruned}${encrypted ? ', age-encrypted' : ', UNENCRYPTED'})`,
    );
    return { file, sizeBytes: size, durationMs: Date.now() - started, pruned, encrypted };
  }

  private async pruneOld(dir: string): Promise<number> {
    const retention = Math.max(1, parseInt(process.env.BACKUP_RETENTION_COUNT ?? '', 10) || DEFAULT_RETENTION);
    const files = (await fs.readdir(dir))
      .filter((f) => f.startsWith('zenskill-backup-') && (f.endsWith('.sql.gz') || f.endsWith('.sql.gz.age')))
      .sort()
      .reverse();
    let pruned = 0;
    for (const f of files.slice(retention)) {
      await fs.unlink(join(dir, f));
      pruned++;
    }
    return pruned;
  }
}
