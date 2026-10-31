import type { Request, Response, NextFunction } from 'express';
import type { ShowRunnerMode } from '../../src/config/runtime.ts';

const ALLOWED_TERMUX_ORIGINS = new Set([
  'http://127.0.0.1:5000',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
]);

export function isOriginAllowed(origin: string | undefined, mode: ShowRunnerMode): boolean {
  if (!origin) return true;

  if (origin.startsWith('chrome-extension://')) {
    return true;
  }

  if (ALLOWED_TERMUX_ORIGINS.has(origin)) {
    return true;
  }

  if (mode === 'preview') {
    if (
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
      /\.run\.app$/i.test(origin) ||
      /\.googleusercontent\.com$/i.test(origin) ||
      /\.google\.com$/i.test(origin)
    ) {
      return true;
    }
  }

  return false;
}

export function createOriginGuardMiddleware(mode: ShowRunnerMode) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (mode === 'termux') {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*;"
      );
    }

    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, mode)) {
      res.status(403).json({
        ok: false,
        error: {
          code: 'FORBIDDEN_ORIGIN',
          message: `Origin "${origin}" is blocked by ShowRunner OS Origin Shield.`,
        },
      });
      return;
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Project-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

export const createOriginAndHeadersMiddleware = createOriginGuardMiddleware;
