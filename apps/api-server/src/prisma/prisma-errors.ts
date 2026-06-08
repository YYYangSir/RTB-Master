export function isPrismaUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { code?: string; name?: string; message?: string };
  if (candidate.code && ['P1001', 'P1002', 'P1008', 'P1017'].includes(candidate.code)) {
    return true;
  }

  const name = candidate.name ?? '';
  if (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    name === 'PrismaClientUnknownRequestError'
  ) {
    return true;
  }

  const message = candidate.message ?? '';
  return [
    "Can't reach database server",
    'Server has closed the connection',
    'Connection refused',
    'ECONNREFUSED',
    'ECONNRESET',
    'Timed out fetching a new connection',
    'the database system is starting up',
  ].some((pattern) => message.includes(pattern));
}
