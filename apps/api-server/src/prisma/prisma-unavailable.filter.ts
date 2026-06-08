import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { isPrismaUnavailableError } from './prisma-errors';

@Catch()
export class PrismaUnavailableFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaUnavailableFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (!isPrismaUnavailableError(exception)) {
      if (exception instanceof HttpException) {
        response.status(exception.getStatus()).json(exception.getResponse());
        return;
      }
      this.logger.error('Unhandled request failure', exception instanceof Error ? exception.stack : String(exception));
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      });
      return;
    }

    this.logger.warn(`Database temporarily unavailable: ${this.messageOf(exception)}`);
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: '服务繁忙，请稍后重试',
      error: 'Service Unavailable',
    });
  }

  private messageOf(exception: unknown) {
    return exception instanceof Error ? exception.message : String(exception);
  }
}
