import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MACHINE_KEY_PATH = path.join(os.homedir(), '.showrunner_machine_key');

/**
 * Loads or generates a 32-byte random machine secret at `~/.showrunner_machine_key` (mode 0600)
 * and derives a 32-byte AES-256-GCM key using HKDF-SHA256.
 */
export function getOrCreateMachineSecret(customPath?: string): Buffer {
  const targetPath = customPath || process.env.SHOWRUNNER_MACHINE_KEY_PATH || DEFAULT_MACHINE_KEY_PATH;

  if (fs.existsSync(targetPath)) {
    const raw = fs.readFileSync(targetPath);
    if (raw.length >= 32) {
      return raw.subarray(0, 32);
    }
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const secret = crypto.randomBytes(32);
  fs.writeFileSync(targetPath, secret, { mode: 0o600 });
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    // Ignore chmod errors on non-POSIX filesystems
  }
  return secret;
}

export function deriveVaultKey(machineSecret?: Buffer): Buffer {
  const secret = machineSecret ?? getOrCreateMachineSecret();
  const derived = crypto.hkdfSync(
    'sha256',
    secret,
    Buffer.alloc(32),
    Buffer.from('ShowRunnerOS-v1.3-VaultKey'),
    32
  );
  return Buffer.from(derived);
}
