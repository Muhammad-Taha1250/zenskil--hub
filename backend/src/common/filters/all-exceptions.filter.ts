import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { currentRequestId } from '../logger/request-context';
import { sanitizeMeta } from '../utils/sanitize';

// Single error envelope for the whole API. 5xx responses never leak stack
// traces or internals to the caller; details go to the structured log.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        code = (b.code as string) || (b.error as string) || code;
        const m = b.message;
        message = Array.isArray(m) ? m.join('; ') : String(m ?? message);
      }
    }

    if (status >= 500) {
      this.logger.error(
        `Unhandled error ${req.method} ${req.url}`,
        sanitizeMeta({ err: String((exception as Error)?.stack || exception) }) as unknown as string,
      );
    }

    res.status(status).json({
      error: { code, message },
      requestId: currentRequestId(),
    });
  }
}
