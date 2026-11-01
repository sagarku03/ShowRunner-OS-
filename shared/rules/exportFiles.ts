import type { AssembledFlowPrompt, FlowPromptPack, PromptBatchCard } from './translate.ts';

export function safeSlug(input?: string): string {
  if (!input || typeof input !== 'string') return 'showrunner';
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'showrunner';
}

/**
 * Pure prompt line joiner according to ShowRunner OS Export Spec (B1 & E5):
 * - EXACTLY ONE prompt per physical line (no multi-line breaking within a prompt).
 * - EXACTLY ONE physical empty blank line between consecutive prompts (\n\n).
 * - Zero header/footer text.
 * - Zero BOM (a BOM breaks #[MM-SS.mmm] detection in Extension & AutoEditor).
 * - Exactly one single final newline at the end (\n).
 */
export function joinPromptLines(prompts: ReadonlyArray<string>): string {
  if (!prompts || prompts.length === 0) {
    return '';
  }

  const sanitized = prompts
    .map((p) => String(p ?? '').replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  if (sanitized.length === 0) {
    return '';
  }

  // Double newline between consecutive prompts, plus a single final newline
  return sanitized.join('\n\n') + '\n';
}

function extractPromptString(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const obj = item as Record<string, unknown>;
  return String(obj.promptLine ?? obj.promptText ?? obj.content ?? '');
}

export function batchToFile(
  batch: PromptBatchCard,
  projectSlug?: string
): { fileName: string; content: string } {
  const slug = safeSlug(projectSlug);
  const padded = String(batch.batchIndex).padStart(2, '0');
  const fileName = `${slug}_batch_${padded}.txt`;
  const lines = (batch.prompts || []).map(extractPromptString);
  return {
    fileName,
    content: joinPromptLines(lines),
  };
}

export function packToFile(
  pack: FlowPromptPack,
  projectSlug?: string
): { fileName: string; content: string } {
  const slug = safeSlug(projectSlug);
  const padded = String(pack.packIndex).padStart(2, '0');
  const fileName = pack.fileName || `${slug}_pack_${padded}.txt`;
  const rawPrompts = (pack as any).prompts;
  const lines = Array.isArray(rawPrompts) && rawPrompts.length > 0
    ? rawPrompts.map(extractPromptString)
    : (pack.content || '').split(/\n\n+/).filter(Boolean);
  return {
    fileName,
    content: joinPromptLines(lines),
  };
}

export function allPromptsFile(
  prompts: ReadonlyArray<AssembledFlowPrompt | string>,
  projectSlug?: string
): { fileName: string; content: string } {
  const slug = safeSlug(projectSlug);
  const fileName = `${slug}_all_prompts.txt`;
  const lines = prompts.map(extractPromptString);
  return {
    fileName,
    content: joinPromptLines(lines),
  };
}

export function allBatchFiles(
  batches: ReadonlyArray<PromptBatchCard>,
  projectSlug?: string
): Array<{ fileName: string; content: string }> {
  return (batches || []).map((b) => batchToFile(b, projectSlug));
}

export function allPackFiles(
  packs: ReadonlyArray<FlowPromptPack>,
  projectSlug?: string
): Array<{ fileName: string; content: string }> {
  return (packs || []).map((p) => packToFile(p, projectSlug));
}
