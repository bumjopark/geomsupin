import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorBody, HttpError, zodMessage } from './util.ts';

/**
 * 공통 오류 처리. 내부 오류 내용은 밖으로 내보내지 않는다.
 * cors=true(위젯 API)면 브라우저가 오류 본문을 읽을 수 있게 CORS 헤더를 붙인다.
 */
export function makeErrorHandler(opts: { cors: boolean }) {
  return (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const withCors = (code: number, body: unknown) => {
      const origin = req.headers.origin;
      if (opts.cors && typeof origin === 'string' && !reply.hasHeader('access-control-allow-origin')) {
        reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      }
      return reply.code(code).send(body);
    };
    if (err instanceof ZodError) {
      const z = zodMessage(err);
      const first = Object.values(z.fields)[0] ?? z.message;
      return withCors(400, errorBody('invalid', opts.cors ? first : z.message, { fields: z.fields }));
    }
    if (err instanceof HttpError) {
      return withCors(err.status, errorBody(err.code, err.message, err.extra));
    }
    const code = (err as { code?: string }).code;
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return withCors(413, errorBody('too_large', '보내는 내용이 너무 큽니다'));
    if (status === 429) return withCors(429, errorBody('too_many', '요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요'));
    if (status >= 400 && status < 500) return withCors(status, errorBody('bad_request', '요청을 처리할 수 없습니다'));
    req.log.error(err);
    return withCors(500, errorBody('server_error', '일시적인 오류가 발생했습니다'));
  };
}
