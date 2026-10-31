export type ShowRunnerMode = 'termux' | 'preview';

export interface RuntimeConfig {
  mode: ShowRunnerMode;
  host: string;
  port: number;
  requireBearerAuth: boolean;
  showPreviewBanner: boolean;
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawMode = (env.SHOWRUNNER_MODE || '').toLowerCase().trim();
  const isProd = env.NODE_ENV === 'production';

  const mode: ShowRunnerMode =
    rawMode === 'termux'
      ? 'termux'
      : rawMode === 'preview'
        ? 'preview'
        : isProd
          ? 'termux'
          : 'preview';

  if (mode === 'termux') {
    const port = Number(env.SHOWRUNNER_PORT) || 5000;
    return {
      mode: 'termux',
      host: '127.0.0.1',
      port,
      requireBearerAuth: true,
      showPreviewBanner: false,
    };
  }

  const port = Number(env.SHOWRUNNER_PORT) || 3000;
  return {
    mode: 'preview',
    host: '0.0.0.0',
    port,
    requireBearerAuth: false,
    showPreviewBanner: true,
  };
}
