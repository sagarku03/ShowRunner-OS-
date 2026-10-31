import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';

const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.showrunner_token');

export function getOrCreateBearerToken(customPath?: string): string {
  const targetPath = customPath || process.env.SHOWRUNNER_TOKEN_PATH || DEFAULT_TOKEN_PATH;

  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(targetPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    // Ignore on non-POSIX
  }
  return token;
}

export function verifyBearerTokenConstantTime(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function createBearerAuthMiddleware(options: {
  expectedToken: string;
  requireBearerAuth?: boolean;
  requireAuth?: boolean;
}) {
  const failureCounts = new Map<string, number>();
  const shouldRequire = Boolean(options.requireBearerAuth ?? options.requireAuth);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!shouldRequire) {
      next();
      return;
    }

    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const providedToken = match ? match[1].trim() : '';

    const remoteKey = req.ip || req.socket.remoteAddress || 'local';
    if (providedToken && verifyBearerTokenConstantTime(providedToken, options.expectedToken)) {
      failureCounts.delete(remoteKey);
      next();
      return;
    }

    const fails = (failureCounts.get(remoteKey) ?? 0) + 1;
    failureCounts.set(remoteKey, fails);
    const delayMs = Math.min(800, Math.pow(2, Math.min(fails - 1, 6)) * 15);
    if (delayMs > 20) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message:
          'Missing or invalid local bearer token. Read ~/.showrunner_token and pass Authorization: Bearer <token>.',
      },
    });
  };
}
