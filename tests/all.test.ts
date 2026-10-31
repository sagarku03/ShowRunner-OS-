import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { createShowRunnerApp } from '../server/app.ts';
import { openDatabase } from '../server/db/db.ts';
import { getStageRow } from '../server/fsm/gates.ts';
import { executeWithKeyFailover, resolveModelForProjectTier } from '../server/llm/gemini.ts';
import { addVaultKey, getActiveDecryptedKeys } from '../server/llm/keyPool.ts';
import { encryptApiKey, decryptApiKey } from '../server/security/vault.ts';
import { handleLockChannelDna } from '../server/stages/s0bChannelDna.ts';
import {
  handleAuditExistingScript,
  handleGenerateAndAuditScript,
  handleSurgicalRepairEndpoint,
} from '../server/stages/s4Script.ts';
import {
  computeDeterministicVideoStats,
  filterClaimsRequiringEvidence,
  inspectThumbnailVision,
  selectDeterministicChannelSample,
  type ChannelVideoItem,
  type ThumbnailVisionResult,
} from '../server/youtube/client.ts';
import {
  alignScriptParagraphs,
  computePrecisionGrade,
  computeTranscriptMetrology,
  decodeTranscriptBytes,
  interpolateCueWordsProportional,
  parseExpressTranscript,
  stripAndCollectNonSpeechTokens,
  validateWordTimestamps,
} from '../shared/rules/transcript.ts';
import {
  applyTranscriptFileUpload,
  clearTranscriptUpload,
  createInitialTranscriptUploadState,
  evaluateExpressChecklist,
  mapErrorToInlineFixCard,
  setTranscriptUnitsOverride,
} from '../shared/rules/expressFlow.ts';
import { runFull17PointAudit } from '../shared/rules/audit.ts';
import {
  normaliseEnglishSpoken,
  numberToEnglishWords,
  replaceDigitsInEnglishProse,
} from '../shared/rules/englishNumbers.ts';
import {
  normaliseSpoken,
  numberToHindiWords,
  replaceDigitsInProse,
  validateSpokenBlock,
} from '../shared/rules/hindiNumbers.ts';
import {
  calculateWordBudget,
  computeEmriFromVectors,
  evaluateTranscriptDrift,
} from '../shared/rules/math.ts';
import {
  formatTimestampTag,
  formatRangeLabel,
  parseTimestampToMs,
  parseTimestampToSeconds,
} from '../shared/rules/timestamps.ts';
import {
  parseTranscriptInput,
  sliceTranscriptTimeline,
  type TranscriptWordTimestamp,
} from '../shared/rules/slicer.ts';
import {
  assembleFlowPrompts,
  buildFlowPromptPacks,
  buildPromptBatches,
  containsRawAuCode,
} from '../shared/rules/translate.ts';
import {
  HARMON_PHASES,
  HARMON_WEIGHT_DENOMINATOR,
  UNIVERSAL_CREATOR_MODE_LABEL,
} from '../src/config/constants.ts';
import {
  buildCompliantHindiParagraphs,
  defaultTestFetch,
  FakeGeminiGateway,
} from './fixtures/fakeGemini.ts';

function makeRealTimedTranscriptJson(wordCount = 240, durationSec = 660): string {
  const step = durationSec / wordCount;
  const words = Array.from({ length: wordCount }, (_, i) => ({
    word: `word_${i + 1}`,
    start: Number((i * step).toFixed(3)),
    end: Number(((i + 1) * step).toFixed(3)),
  }));
  return JSON.stringify(words);
}

async function startTestServer(params: {
  db: ReturnType<typeof openDatabase>;
  gemini?: FakeGeminiGateway;
  expectedToken?: string;
  mode?: 'termux' | 'preview';
  customFetch?: typeof fetch;
}): Promise<{
  baseUrl: string;
  token: string;
  close: () => Promise<void>;
}> {
  const token = params.expectedToken ?? 'test-bearer-token-32bytes-secret-001';
  const mode = params.mode ?? 'termux';
  const app = createShowRunnerApp({
    db: params.db,
    runtime: {
      mode,
      host: '127.0.0.1',
      port: 0,
      requireBearerAuth: mode === 'termux',
      showPreviewBanner: mode === 'preview',
    },
    expectedToken: token,
    gemini: params.gemini ?? new FakeGeminiGateway(),
    customFetch: params.customFetch ?? defaultTestFetch,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('ShowRunner OS v1.3.0 — Part F Acceptance Suites (T1–T15) & Core Regression Suites', () => {
  // ===========================================================================
  // T1: Live key validation & error mapper (Part A1)
  // ===========================================================================
  it('T1 — Live key validation & error mapper: 200 valid -> VALID + models stored; 401 -> INVALID_KEY (not active); 429 -> QUOTA_EXCEEDED; empty models -> NO_USABLE_MODEL; calling any stage with no model selected -> 422 NO_USABLE_MODEL', async () => {
    const db = openDatabase(':memory:');
    let mockMode: 'VALID' | '401' | '429' | 'EMPTY_MODELS' = 'VALID';

    const customFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (mockMode === '401') {
        return new Response(
          JSON.stringify({ error: { code: 401, message: 'API key not valid' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (mockMode === '429') {
        return new Response(
          JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted' } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (mockMode === 'EMPTY_MODELS') {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v1beta/models')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-pro-latest',
                displayName: 'Gemini Pro Latest',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-flash-latest',
                displayName: 'Gemini Flash Latest',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-embedding-exp',
                displayName: 'Gemini Embedding Exp',
                supportedGenerationMethods: ['embedContent'],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const srv = await startTestServer({ db, customFetch });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      // 1. 401 -> INVALID_KEY (not activated)
      mockMode = '401';
      const r401 = await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-invalid-401', projectLabel: 'Bad Key' }),
      });
      assert.equal(r401.status, 201);
      const b401 = (await r401.json()) as {
        data: { key: { status: string }; valid: boolean };
      };
      assert.equal(b401.data.key.status, 'INVALID_KEY');
      assert.equal(b401.data.valid, false);
      assert.equal(getActiveDecryptedKeys(db).length, 0);

      // 2. 429 -> QUOTA_EXCEEDED
      mockMode = '429';
      const r429 = await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-quota-429', projectLabel: 'Quota Key' }),
      });
      const b429 = (await r429.json()) as { data: { key: { status: string } } };
      assert.equal(b429.data.key.status, 'QUOTA_EXCEEDED');

      // 3. Empty models -> MODEL_ACCESS_DENIED on key & NO_USABLE_MODEL on discovery
      mockMode = 'EMPTY_MODELS';
      const rEmpty = await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-empty-models', projectLabel: 'Empty Key' }),
      });
      const bEmpty = (await rEmpty.json()) as { data: { key: { status: string } } };
      assert.equal(bEmpty.data.key.status, 'MODEL_ACCESS_DENIED');

      // 4. 200 valid -> VALID + models stored
      mockMode = 'VALID';
      const rValid = await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-valid-200', projectLabel: 'Good Key' }),
      });
      const bValid = (await rValid.json()) as {
        data: {
          key: {
            id: number;
            status: string;
            discoveredModels: {
              reasoningModels: Array<{ id: string }>;
              fastModels: Array<{ id: string }>;
            };
          };
          valid: boolean;
        };
      };
      assert.equal(bValid.data.key.status, 'VALID');
      assert.equal(bValid.data.valid, true);
      assert.ok(bValid.data.key.discoveredModels.reasoningModels.length > 0);
      assert.ok(bValid.data.key.discoveredModels.fastModels.length > 0);

      // Test POST /api/v1/vault/keys/:id/test and GET /api/v1/health/llm
      const retestRes = await fetch(
        `${srv.baseUrl}/api/v1/vault/keys/${bValid.data.key.id}/test`,
        { method: 'POST', headers }
      );
      assert.equal(retestRes.status, 200);
      const healthRes = await fetch(`${srv.baseUrl}/api/v1/health/llm`, { headers });
      const healthBody = (await healthRes.json()) as {
        data: { validKeys: number; models: { reasoningModels: string[] } };
      };
      assert.equal(healthBody.data.validKeys, 1);
      assert.ok(healthBody.data.models.reasoningModels.length > 0);

      // 5. Create project with autoSelectDiscoveredModels: false (no model selected) -> calling S1 after DNA lock throws 422 NO_USABLE_MODEL
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'No Model Project',
          niche: 'Personal Finance',
          autoSelectDiscoveredModels: false,
        }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      handleLockChannelDna({
        db,
        projectId,
        dna: {
          source: 'NICHE',
          identity: {
            niche: 'Personal Finance',
            subNiche: 'College',
            pillars: ['Explainer'],
            audiencePersona: 'Students',
            valueProp: 'Clarity',
            differentiator: 'Practical',
          },
        },
      });

      assert.throws(
        () => resolveModelForProjectTier(db, projectId, 'TIER_REASONING'),
        (err: Error & { code?: string; statusCode?: number }) =>
          err.code === 'NO_USABLE_MODEL' && err.statusCode === 422
      );

      const s1NoModel = await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'ideate', niche: 'Personal Finance' }),
      });
      assert.equal(s1NoModel.status, 422);
      const s1Err = (await s1NoModel.json()) as { error: { code: string; message: string } };
      assert.equal(s1Err.error.code, 'NO_USABLE_MODEL');
      assert.ok(s1Err.error.message.includes('Open Vault → Test key → pick a model'));
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T2: VTT / SRT / JSON parser (Part A2 & A3)
  // ===========================================================================
  it('T2 — VTT / SRT / JSON parser: parses WebVTT (with/without hours, cue settings, NOTE/STYLE, <c> tags), SRT, all 6 JSON schemas, and throws TRANSCRIPT_INVALID with offendingIndex on corrupt inputs', () => {
    // 1. WebVTT with cue settings, NOTE/STYLE blocks, <c> tags, with and without hours
    const vttContent = [
      'WEBVTT',
      '',
      'NOTE This is a comment block',
      'spanning two lines',
      '',
      'STYLE',
      '::cue { color: yellow; }',
      '',
      'cue-1',
      '00:00:01.200 --> 00:00:04.850 align:start position:0%',
      '<c.yellow>First</c> spoken <00:00:02.000>phrase here',
      '',
      '2',
      '01:02.500 --> 01:05.000 line:90%',
      'Second cue without hours',
    ].join('\n');

    const vttWords = parseTranscriptInput(vttContent);
    assert.ok(vttWords.length >= 7);
    assert.equal(vttWords[0].startSec, 1.2);
    // Last word of first cue must end at 4.85
    const cue1End = vttWords[3].endSec;
    assert.equal(cue1End, 4.85);
    // Last word of second cue must end at 65.0
    const cue2End = vttWords[vttWords.length - 1].endSec;
    assert.equal(cue2End, 65.0);
    for (let i = 0; i < vttWords.length; i++) {
      assert.ok(Number.isFinite(vttWords[i].startSec) && Number.isFinite(vttWords[i].endSec));
      assert.ok(vttWords[i].endSec > vttWords[i].startSec);
      if (i > 0) {
        assert.ok(vttWords[i].startSec >= vttWords[i - 1].startSec);
      }
    }

    // 2. SRT with comma milliseconds and sequence numbers
    const srtContent = [
      '1',
      '00:00:00,500 --> 00:00:03,250',
      'नमस्ते दुनिया यह पहला वाक्य है',
      '',
      '2',
      '00:00:03,250 --> 00:00:06,750',
      'और यह दूसरा वाक्य है',
    ].join('\n');
    const srtWords = parseTranscriptInput(srtContent);
    assert.equal(srtWords[0].startSec, 0.5);
    assert.equal(srtWords[srtWords.length - 1].endSec, 6.75);

    // 3. JSON in all 6 schemas
    const s1 = parseTranscriptInput(
      JSON.stringify([
        { word: 'one', start: 0.0, end: 0.5 },
        { word: 'two', start: 0.5, end: 1.1 },
      ])
    );
    assert.equal(s1.length, 2);
    assert.equal(s1[1].endSec, 1.1);

    const s2 = parseTranscriptInput(
      JSON.stringify([
        { word: 'one', startSec: 0.0, endSec: 0.6 },
        { word: 'two', startSec: 0.6, endSec: 1.2 },
      ])
    );
    assert.equal(s2[1].endSec, 1.2);

    const s3 = parseTranscriptInput(
      JSON.stringify([
        { text: 'hello world', start: 1.0, end: 2.0 },
        { text: 'again', start: 2.0, end: 2.5 },
      ])
    );
    assert.equal(s3.length, 3);
    assert.equal(s3[2].endSec, 2.5);

    const s4 = parseTranscriptInput(
      JSON.stringify([
        { word: 'alpha', start_time: 0.2, end_time: 0.8 },
        { word: 'beta', start_time: 0.8, end_time: 1.4 },
      ])
    );
    assert.equal(s4[1].endSec, 1.4);

    // Millisecond integers auto-detected
    const s5 = parseTranscriptInput(
      JSON.stringify({
        unit: 'ms',
        words: [
          { word: 'ms1', start: 1200, end: 1800 },
          { word: 'ms2', start: 1800, end: 2500 },
        ],
      })
    );
    assert.equal(s5[0].startSec, 1.2);
    assert.equal(s5[1].endSec, 2.5);

    // WhisperX {segments:[{words:[...]}]}
    const s6Whisper = parseTranscriptInput(
      JSON.stringify({
        segments: [
          {
            words: [
              { word: 'whisper', start: 0.1, end: 0.4 },
              { word: 'test', start: 0.4, end: 0.9 },
            ],
          },
        ],
      })
    );
    assert.equal(s6Whisper.length, 2);
    assert.equal(s6Whisper[1].endSec, 0.9);

    // Descript {words:[...]}
    const s6Descript = parseTranscriptInput(
      JSON.stringify({
        words: [
          { text: 'descript', start: 0.0, end: 0.5 },
          { text: 'ok', start: 0.5, end: 1.0 },
        ],
      })
    );
    assert.equal(s6Descript.length, 2);

    // 4. Corrupt inputs -> TRANSCRIPT_INVALID with offendingIndex
    // Reversed times (end <= start)
    assert.throws(
      () =>
        parseTranscriptInput(
          JSON.stringify([
            { word: 'ok', start: 0, end: 1 },
            { word: 'bad', start: 2.0, end: 1.5 },
          ])
        ),
      (err: Error & { code?: string; offendingIndex?: number }) =>
        err.code === 'TRANSCRIPT_INVALID' && err.offendingIndex === 1
    );

    // Negative time
    assert.throws(
      () =>
        parseTranscriptInput(
          JSON.stringify([{ word: 'neg', start: -0.5, end: 0.5 }])
        ),
      (err: Error & { code?: string; offendingIndex?: number }) =>
        err.code === 'TRANSCRIPT_INVALID' && err.offendingIndex === 0
    );

    // NaN / null time
    assert.throws(
      () =>
        parseTranscriptInput(
          JSON.stringify([{ word: 'nulltime', start: 0, end: null }])
        ),
      (err: Error & { code?: string; offendingIndex?: number }) =>
        err.code === 'TRANSCRIPT_INVALID' && err.offendingIndex === 0
    );

    // Non-monotonic
    assert.throws(
      () =>
        parseTranscriptInput(
          JSON.stringify([
            { word: 'a', start: 1.0, end: 2.0 },
            { word: 'b', start: 0.5, end: 2.5 },
          ])
        ),
      (err: Error & { code?: string; offendingIndex?: number }) =>
        err.code === 'TRANSCRIPT_INVALID' && err.offendingIndex === 1
    );

    // Plain untimed text -> TRANSCRIPT_INVALID
    assert.throws(
      () => parseTranscriptInput('Just plain text without any timecodes at all'),
      (err: Error & { code?: string }) => err.code === 'TRANSCRIPT_INVALID'
    );
  });

  // ===========================================================================
  // T3: formatTimestampTag integer-ms boundary & canonical PRD format
  // ===========================================================================
  it('T3 — formatTimestampTag canonical PRD #[MM-SS.mmm]: 59.9996 -> #[01-00.000]; 3599.5 -> #[59-59.500]; 0.0004 -> #[00-00.000]; 4503.45 -> #[75-03.450]; never :60.', () => {
    assert.equal(formatTimestampTag(59.9996), '#[01-00.000]');
    assert.equal(formatTimestampTag(3599.5), '#[59-59.500]');
    assert.equal(formatTimestampTag(0.0004), '#[00-00.000]');
    assert.equal(formatTimestampTag(4503.45), '#[75-03.450]');
    assert.ok(!formatTimestampTag(59.9996).includes(':60.'));
    assert.ok(!formatTimestampTag(119.9996).includes(':60.'));
    assert.ok(!formatTimestampTag(59.9996).includes(':')); // zero colons in prompt tag
    assert.equal(formatRangeLabel(83450, 87100, true), '01:23.450 → 01:27.100');

    // Integer ms over synthetic stream has zero float drift
    const stepMs = 350;
    const endMs = 3 * 3600 * 1000; // 3 hours
    for (let cur = 0; cur <= Math.min(cur + stepMs * 200, endMs); cur += stepMs) {
      const tag = formatTimestampTag(cur, true);
      assert.ok(/^#\[\d{2,}-\d{2}\.\d{3}\]$/.test(tag));
      const parsedMs = parseTimestampToMs(tag);
      assert.equal(parsedMs, cur);
    }
  });

  // ===========================================================================
  // T4: Stage 4 no-transcript rejection (Part A4)
  // ===========================================================================
  it('T4 — Stage 4 no-transcript rejection: calling S4 without transcript -> 422 TRANSCRIPT_REQUIRED', async () => {
    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t4-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'T4 Project', niche: 'Science' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      handleLockChannelDna({ db, projectId, dna: { source: 'NICHE' } });
      await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'custom', topic: 'Circadian Nadir', niche: 'Science' }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/research`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/approve`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2_5/runtime`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ targetMinutes: 11, wpm: 187.41 }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/3/script`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });

      const s4NoTranscript = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ actualDurationSec: 660 }),
      });
      assert.equal(s4NoTranscript.status, 422);
      const errBody = (await s4NoTranscript.json()) as { error: { code: string } };
      assert.equal(errBody.error.code, 'TRANSCRIPT_REQUIRED');
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T5: Stage 7/6 no-fallback (Part A5)
  // ===========================================================================
  it('T5 — Stage 7/6 no-fallback: fake adapter returning 2 variants retries twice then throws PACKAGING_INCOMPLETE (never fabricates a 3rd); same for S6 missing fields', async () => {
    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway({
      s7IncompleteTimes: 5,
      s6IncompleteTimes: 5,
    });
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t5-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'T5 Project', niche: 'Science' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      handleLockChannelDna({ db, projectId, dna: { source: 'NICHE' } });
      await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'custom', topic: 'Circadian Nadir', niche: 'Science' }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/research`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/approve`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2_5/runtime`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ targetMinutes: 11, wpm: 187.41 }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/3/script`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          transcript: makeRealTimedTranscriptJson(120, 660),
          actualDurationSec: 660,
        }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });

      // S6 fails after retrying when visualSpecs are missing
      const s6FailRes = await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s6FailRes.status, 422);
      const s6FailBody = (await s6FailRes.json()) as { error: { code: string } };
      assert.equal(s6FailBody.error.code, 'PACKAGING_INCOMPLETE');

      // Now allow S6 to succeed so we can test S7 incomplete variants
      gemini.options.s6IncompleteTimes = 0;
      const s6OkRes = await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s6OkRes.status, 202);

      // S7 returns only 2 variants across initial + 2 retries -> 422 PACKAGING_INCOMPLETE
      const beforeS7Calls = gemini.structuredCalls.filter((c) =>
        c.systemInstruction.includes('Stage 7 Packaging')
      ).length;
      const s7FailRes = await fetch(`${srv.baseUrl}/api/v1/stage/7/packaging`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s7FailRes.status, 422);
      const s7FailBody = (await s7FailRes.json()) as { error: { code: string } };
      assert.equal(s7FailBody.error.code, 'PACKAGING_INCOMPLETE');
      const afterS7Calls = gemini.structuredCalls.filter((c) =>
        c.systemInstruction.includes('Stage 7 Packaging')
      ).length;
      assert.equal(afterS7Calls - beforeS7Calls, 3, 'Expected 1 initial call + 2 retries');
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T6: Master Prompt Override (Part B)
  // ===========================================================================
  it('T6 — Master Prompt Override: save -> extract -> inject into S1, S2, S2.5 (custom chapters override Harmon), S3 (persona + banned words in C05 + brand in C07), S5/S6 (negative prompts appended); editing after S3 marks S1..S3 DIRTY; empty prompt -> Universal Any-Niche Creator Mode', async () => {
    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t6-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'T6 Master Override', niche: 'Finance' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      // 1. Empty prompt -> Universal Any-Niche Creator Mode
      const emptyRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/master-prompt`, {
        method: 'PUT',
        headers: pHeaders,
        body: JSON.stringify({ text: '' }),
      });
      const emptyBody = (await emptyRes.json()) as {
        data: { masterPrompt: { isUniversalMode: boolean; modeLabel: string } };
      };
      assert.equal(emptyBody.data.masterPrompt.isUniversalMode, true);
      assert.equal(emptyBody.data.masterPrompt.modeLabel, UNIVERSAL_CREATOR_MODE_LABEL);

      // 2. Save custom Master Prompt Override
      const mpRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/master-prompt`, {
        method: 'PUT',
        headers: pHeaders,
        body: JSON.stringify({
          text: 'Brand: PulseLock\nChapters: Ch1 Trap, Ch2 Math, Ch3 Bias, Ch4 System, Ch5 Proof, Ch6 Protocol, Ch7 Payoff\nAvoid neon cyberpunk clutter.',
        }),
      });
      assert.equal(mpRes.status, 200);
      const mpData = (await mpRes.json()) as {
        data: {
          masterPrompt: {
            extracted: { brandName: string; customChapters: string[]; negativePrompts: string[] };
          };
        };
      };
      assert.equal(mpData.data.masterPrompt.extracted.brandName, 'PulseLock');
      assert.equal(mpData.data.masterPrompt.extracted.customChapters.length, 7);

      handleLockChannelDna({ db, projectId, dna: { source: 'NICHE' } });

      // Run S1, S2, S2.5, S3, S4, S5, S6
      await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'custom', topic: 'Compounding Trap', niche: 'Finance' }),
      });
      const s1Call = gemini.structuredCalls.find((c) =>
        c.systemInstruction.includes('Stage 1 Option B')
      )!;
      assert.ok(s1Call.systemInstruction.includes('Sharp investigative storyteller'));

      await fetch(`${srv.baseUrl}/api/v1/stage/2/research`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/approve`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });

      const s25Res = await fetch(`${srv.baseUrl}/api/v1/stage/2_5/runtime`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ targetMinutes: 11, wpm: 187.41 }),
      });
      const s25Data = (await s25Res.json()) as {
        data: { runtime: { chapters: Array<{ chapterTitle: string }> } };
      };
      // Custom chapters override Harmon chapter titles!
      assert.equal(s25Data.data.runtime.chapters[0].chapterTitle, 'Ch1 Trap');
      assert.equal(s25Data.data.runtime.chapters[6].chapterTitle, 'Ch7 Payoff');

      const s3Res = await fetch(`${srv.baseUrl}/api/v1/stage/3/script`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s3Res.status, 202);
      const s3Call = gemini.structuredCalls.find((c) =>
        c.systemInstruction.includes('Stage 3 Dual-Output Script Engine')
      )!;
      assert.ok(s3Call.systemInstruction.includes('PulseLock'));
      assert.ok(s3Call.systemInstruction.includes('synergy'));

      await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          transcript: makeRealTimedTranscriptJson(120, 660),
          actualDurationSec: 660,
        }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      const s6Res = await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      const s6Data = (await s6Res.json()) as {
        data: { prompts: { prompts: Array<{ promptLine: string }> } };
      };
      assert.ok(
        s6Data.data.prompts.prompts[0].promptLine.includes('neon cyberpunk clutter'),
        'Negative prompts from Master Prompt Override must be appended to R5 negative matrix'
      );

      // Editing Master Prompt after S3 marks S1..S3 DIRTY with reason "Master prompt changed"
      await fetch(`${srv.baseUrl}/api/v1/stage/0/master-prompt`, {
        method: 'PUT',
        headers: pHeaders,
        body: JSON.stringify({ text: 'Brand: UpdatedBrand\nUpdated persona instructions.' }),
      });
      for (const st of ['S1', 'S2', 'S2.5', 'S3'] as const) {
        const row = getStageRow(db, projectId, st)!;
        assert.equal(row.is_dirty, 1, `Expected ${st} to be marked DIRTY`);
      }
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T7: Secret scan (Part A7)
  // ===========================================================================
  it('T7 — Secret scan: scripts/secret-scan.sh exits 0 on the repo and exits non-zero on a temp file containing a fake key pattern', () => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/secret-scan.sh');
    // 1. Exits 0 on the repository
    const cleanOut = execFileSync('bash', [scriptPath, '.'], { encoding: 'utf8' });
    assert.ok(cleanOut.includes('PASS'));

    // 2. Exits non-zero on a temp directory containing a constructed secret pattern
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-secret-scan-'));
    try {
      const fakeLeak = 'AI' + 'za' + 'SyD91234567890abcdefghijklmnopqrstuv';
      fs.writeFileSync(path.join(tmpDir, 'leaked.txt'), `key=${fakeLeak}\n`, 'utf8');
      let failed = false;
      try {
        execFileSync('bash', [scriptPath, tmpDir], { encoding: 'utf8', stdio: 'pipe' });
      } catch {
        failed = true;
      }
      assert.equal(failed, true, 'Expected secret-scan.sh to exit non-zero on leaked key');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // T8: Async jobs (Part A6)
  // ===========================================================================
  it('T8 — Async jobs: stage POST returns 202 {jobId}; GET /api/v1/jobs/:id transitions RUNNING -> DONE; simulated restart marks RUNNING jobs FAILED', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-jobs-test-'));
    const dbPath = path.join(tmpDir, 'jobs.sqlite');

    try {
      const db = openDatabase(dbPath);
      const gemini = new FakeGeminiGateway();
      const srv = await startTestServer({ db, gemini });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };

      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t8-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Async Job Project', niche: 'Tech' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      handleLockChannelDna({ db, projectId, dna: { source: 'NICHE' } });

      // Stage POST with Prefer: respond-async returns 202 immediately and transitions RUNNING -> DONE
      const postRes = await fetch(`${srv.baseUrl}/api/v1/stage/1/topics?async=1`, {
        method: 'POST',
        headers: { ...pHeaders, Prefer: 'respond-async' },
        body: JSON.stringify({ mode: 'ideate', niche: 'Tech' }),
      });
      assert.equal(postRes.status, 202);
      const postBody = (await postRes.json()) as { jobId: string; data: { jobId: string } };
      const jobId = postBody.jobId || postBody.data.jobId;
      assert.ok(jobId.startsWith('job-'));

      // Poll GET /api/v1/jobs/:id until DONE
      let finalStatus = 'RUNNING';
      for (let i = 0; i < 20; i++) {
        const jRes = await fetch(`${srv.baseUrl}/api/v1/jobs/${jobId}`, { headers: pHeaders });
        const jBody = (await jRes.json()) as {
          data: { status: string; progressPct: number; phase: string };
        };
        finalStatus = jBody.data.status;
        if (finalStatus === 'DONE') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(finalStatus, 'DONE');

      // Insert a stale RUNNING job and simulate server restart (re-opening DB)
      db.prepare(
        `INSERT INTO jobs (id, project_id, stage_id, status, progress_pct, phase, message)
         VALUES ('job-stale-01', ?, 'S2', 'RUNNING', 45, 'STEP_2A', 'Running...')`
      ).run(projectId);

      await srv.close();
      db.close();

      const dbRestarted = openDatabase(dbPath);
      const staleRow = dbRestarted
        .prepare(`SELECT status, phase FROM jobs WHERE id = 'job-stale-01'`)
        .get() as { status: string; phase: string };
      assert.equal(staleRow.status, 'FAILED');
      assert.equal(staleRow.phase, 'FAILED_ON_BOOT');
      dbRestarted.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // T9: Channel DNA – Existing channel (Path A, C2)
  // ===========================================================================
  it('T9 — Channel DNA Existing channel (Path A): 12 videos (9 normal ~10K, 3 outliers 150K/220K/400K) -> sample selector picks 3 outliers + 2 median + 1 lowest + 2 newest; deterministic stats match hand-calculated values; drops un-evidenced LLM claims', () => {
    const baseDate = new Date('2025-01-01T00:00:00Z').getTime();
    const viewsList = [
      9500, // vid-1 (lowest)
      10000, // vid-2
      10200, // vid-3
      10500, // vid-4
      10800, // vid-5 (median area)
      11000, // vid-6 (median area)
      11200, // vid-7
      11500, // vid-8 (newest normal)
      12000, // vid-9 (newest normal)
      150000, // vid-10 (outlier)
      220000, // vid-11 (outlier)
      400000, // vid-12 (top outlier)
    ];

    const timedWords: TranscriptWordTimestamp[] = Array.from({ length: 175 }, (_, i) => ({
      word: `word_${i + 1}`,
      startSec: Number(((i / 175) * 60).toFixed(3)),
      endSec: Number((((i + 1) / 175) * 60).toFixed(3)),
    }));

    const videos: ChannelVideoItem[] = viewsList.map((views, idx) => ({
      videoId: `vid-${idx + 1}`,
      channelId: 'UC_TEST_12',
      title: `Why System #${idx + 1} Fails Under Load?`,
      description: `Detailed engineering breakdown of system ${idx + 1}. First sentence has five words. Second sentence has five words.`,
      publishedAt: new Date(baseDate + idx * 7 * 86400_000).toISOString(),
      durationSec: 660,
      views,
      transcriptWords: idx === 0 ? timedWords : undefined,
      transcriptText: 'First sentence has five words. Second sentence has five words.',
    }));

    const sample = selectDeterministicChannelSample(videos, 'STANDARD');
    assert.equal(sample.outliers.length, 3);
    assert.deepEqual(
      sample.outliers.map((v) => v.videoId),
      ['vid-12', 'vid-11', 'vid-10']
    );
    assert.equal(sample.lowest.length, 1);
    assert.equal(sample.lowest[0].videoId, 'vid-1');
    assert.equal(sample.medians.length, 2);
    assert.equal(sample.newest.length, 2);
    assert.equal(sample.sampled.length, 8);

    const stats = computeDeterministicVideoStats(videos);
    // Sorted views: 9500, 10000, 10200, 10500, 10800, 11000, 11200, 11500, 12000, 150000, 220000, 400000
    // Median of 12 items = (11000 + 11200) / 2 = 11100
    assert.equal(stats.medianViews, 11100);
    assert.equal(stats.wpmStats.measuredWpm, 175);
    assert.equal(stats.titleStats.questionRatio, 1);

    // Filter out claims without valid evidence[]
    const filtered = filterClaimsRequiringEvidence([
      {
        claim: 'Valid Pattern',
        evidence: [{ videoId: 'vid-12', quoteOrTimestamp: 'Why System #12 Fails Under Load?' }],
      },
      {
        claim: 'Hallucinated Pattern With Empty Evidence',
        evidence: [],
      },
    ]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].claim, 'Valid Pattern');
  });

  // ===========================================================================
  // T10: Channel DNA – Edge cases (C2)
  // ===========================================================================
  it('T10 — Channel DNA Edge cases: channel with 3 videos -> CHANNEL_TOO_SMALL; private/404 -> CHANNEL_NOT_FOUND; missing YouTube key falls back to RSS; RSS failure falls back to manual URLs', async () => {
    // 1. 3 videos -> CHANNEL_TOO_SMALL
    const threeVideos: ChannelVideoItem[] = [1, 2, 3].map((i) => ({
      videoId: `v-${i}`,
      channelId: 'UC_SMALL',
      title: `Video ${i}`,
      description: 'Desc',
      publishedAt: new Date().toISOString(),
      durationSec: 600,
      views: 1000 * i,
    }));
    assert.throws(
      () => selectDeterministicChannelSample(threeVideos, 'STANDARD'),
      (err: Error & { code?: string }) => err.code === 'CHANNEL_TOO_SMALL'
    );

    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway();

    // Custom fetch that returns 404 for unknown channel, RSS XML for UC_RSS_CHAN, and fails RSS for UC_MANUAL_CHAN
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
        <title>RSS Tech Channel</title>
        ${[1, 2, 3, 4, 5, 6]
          .map(
            (i) => `<entry>
          <yt:videoId>rssvid0000${i}</yt:videoId>
          <title>Why Chip #${i} Overheats</title>
          <published>2025-01-0${i}T00:00:00Z</published>
          <media:group><media:description>Detailed description for video ${i}.</media:description></media:group>
          <media:community><media:statistics views="${10000 * i}"/></media:community>
        </entry>`
          )
          .join('\n')}
      </feed>`;

    const customFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1beta/models')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-pro-latest',
                displayName: 'Pro',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-flash-latest',
                displayName: 'Flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes(':generateContent')) {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }),
          { status: 200 }
        );
      }
      if (url.includes('feeds/videos.xml?channel_id=UC_RSS_CHAN')) {
        return new Response(rssXml, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const srv = await startTestServer({ db, gemini, customFetch });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t10-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'T10 Edge Cases', niche: 'Tech' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      // 2. 404 channel without manual URLs -> CHANNEL_NOT_FOUND
      const notFoundRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/analyse-channel`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ channelInput: 'UC_NON_EXISTENT_404' }),
      });
      assert.equal(notFoundRes.status, 404);
      const nfBody = (await notFoundRes.json()) as { error: { code: string } };
      assert.equal(nfBody.error.code, 'CHANNEL_NOT_FOUND');

      // 3. Missing YouTube key falls back to public RSS feed for UC_RSS_CHAN
      const rssRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/analyse-channel`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ channelInput: 'UC_RSS_CHAN', depth: 'QUICK' }),
      });
      assert.equal(rssRes.status, 202);
      const rssData = (await rssRes.json()) as {
        data: {
          candidateDna: {
            source: string;
            evidence: Array<{ field: string; videoId: string; quoteOrTimestamp: string }>;
          };
          droppedClaimsCount: number;
        };
      };
      assert.equal(rssData.data.candidateDna.source, 'ANALYSED');
      assert.equal(rssData.data.droppedClaimsCount, 1);
      assert.ok(rssData.data.candidateDna.evidence.length >= 2);

      // 4. RSS failure falls back to manualVideos
      const manualRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/analyse-channel`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          channelInput: '@ManualFallbackChannel',
          manualVideos: [1, 2, 3, 4, 5].map((i) => ({
            videoId: `manvid0000${i}`,
            title: `Manual Video #${i}`,
            description: `Description ${i}`,
            views: 5000 * i,
            publishedAt: new Date().toISOString(),
          })),
        }),
      });
      assert.equal(manualRes.status, 202);
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T11: Channel DNA – New channel / any niche (Path B, C3)
  // ===========================================================================
  it('T11 — Channel DNA New channel / any niche (Path B): Step 2A grounded search (no schema) + Step 2B schema (no tools) -> returns 3 distinct Style Options; locking option 2 produces valid ChannelDNA with source: NICHE', async () => {
    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t11-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Hinglish Finance Show',
          niche: 'Personal finance for college students in Hinglish',
        }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      const nicheRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/analyse-niche`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          niche: 'Personal finance for college students in Hinglish',
          language: 'hi',
          formatPreset: 'EXPLAINER',
        }),
      });
      assert.equal(nicheRes.status, 202);
      const nicheBody = (await nicheRes.json()) as {
        data: {
          styleOptions: Array<{
            optionId: string;
            label: string;
            dna: { source: string; voice: { wpm: number } };
          }>;
        };
      };
      assert.equal(nicheBody.data.styleOptions.length, 3);

      // Verify Step 2A grounded search had no responseSchema, and Step 2B had no tools
      const groundedCall = gemini.groundedCalls.find((c) => c.stage === 'S0B_NICHE_SEARCH')!;
      assert.ok(groundedCall);
      assert.equal(groundedCall.hasResponseSchema, false);
      const synthCall = gemini.structuredCalls.find(
        (c) => c.stage === 'S0B_NICHE_SYNTHESIS'
      )!;
      assert.ok(synthCall);
      assert.equal(synthCall.hasTools, false);

      // Lock option 2
      const lockRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/lock`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ dna: nicheBody.data.styleOptions[1].dna }),
      });
      assert.equal(lockRes.status, 200);
      const lockBody = (await lockRes.json()) as {
        data: { dnaRecord: { version: number; dna: { source: string }; hash: string } };
      };
      assert.equal(lockBody.data.dnaRecord.dna.source, 'NICHE');
      assert.equal(lockBody.data.dnaRecord.version, 1);
      assert.ok(lockBody.data.dnaRecord.hash.length > 8);
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T12: Channel DNA – Reference channels (Path C) & anti-copy guard (C4)
  // ===========================================================================
  it('T12 — Channel DNA Reference channels (Path C) & anti-copy guard: 2 reference channels merged into source: HYBRID; attempting to lock a Stage 1 title with >0.78 similarity to a reference title triggers regeneration and never locks a clone', async () => {
    const db = openDatabase(':memory:');
    const clonedTitle = 'Why Modern Graphics Cards Melt Under Load';
    const gemini = new FakeGeminiGateway({
      s1CustomCandidateTitles: [clonedTitle],
    });
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t12-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Hybrid Ref Project', niche: 'Hardware' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      const refRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/analyse-references`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          channels: [
            {
              channelInput: '@RefChan1',
              manualVideos: [1, 2, 3, 4, 5].map((i) => ({
                videoId: `ref1vid000${i}`,
                title: i === 1 ? clonedTitle : `Ref1 Video #${i}`,
                description: `Ref1 desc ${i}`,
                views: 15000 * i,
                publishedAt: new Date().toISOString(),
              })),
            },
            {
              channelInput: '@RefChan2',
              manualVideos: [1, 2, 3, 4, 5].map((i) => ({
                videoId: `ref2vid000${i}`,
                title: `Ref2 Video #${i}`,
                description: `Ref2 desc ${i}`,
                views: 12000 * i,
                publishedAt: new Date().toISOString(),
              })),
            },
          ],
        }),
      });
      assert.equal(refRes.status, 202);
      const refData = (await refRes.json()) as {
        data: { candidateDna: Record<string, unknown> };
      };
      assert.equal(refData.data.candidateDna.source, 'HYBRID');

      // Lock the hybrid DNA with a known reference title
      await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/lock`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          dna: {
            ...refData.data.candidateDna,
            referenceTitles: [clonedTitle],
          },
        }),
      });

      // Attempting to lock a clone title (>0.78 similarity) in Stage 1 must fail with 422 REFERENCE_SIMILARITY_EXCEEDED
      const cloneLockRes = await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          mode: 'lock',
          customTopic: { title: 'Why Modern Graphics Cards Melt Under Load!' },
        }),
      });
      assert.equal(cloneLockRes.status, 422);
      const cloneErr = (await cloneLockRes.json()) as { error: { code: string } };
      assert.equal(cloneErr.error.code, 'REFERENCE_SIMILARITY_EXCEEDED');

      // Ideation with a cloned candidate triggers regeneration and filters out the clone
      const ideateRes = await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'ideate', niche: 'Hardware' }),
      });
      assert.equal(ideateRes.status, 202);
      const ideateBody = (await ideateRes.json()) as {
        data: { candidates: Array<{ title: string }> };
      };
      assert.ok(
        ideateBody.data.candidates.every((c) => c.title !== clonedTitle),
        'Cloned reference title must never appear in final candidates'
      );
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T13: DNA lock & invalidation (C8)
  // ===========================================================================
  it('T13 — DNA lock & invalidation: running S1 without locked DNA -> 409 GATE_DNA_NOT_LOCKED; locking DNA enables S1; editing DNA after S3 marks S1..S3 DIRTY with reason "DNA changed" and increments dna_version', async () => {
    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t13-valid', projectLabel: 'Key 1' }),
      });
      const projRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'DNA Gate Project', niche: 'Science' }),
      });
      const projectId = ((await projRes.json()) as { data: { project: { id: string } } }).data
        .project.id;
      const pHeaders = { ...headers, 'X-Project-Id': projectId };

      // 1. Running S1 without locked DNA -> 409 GATE_DNA_NOT_LOCKED
      const blockedS1 = await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'ideate', niche: 'Science' }),
      });
      assert.equal(blockedS1.status, 409);
      const blockedErr = (await blockedS1.json()) as { error: { code: string } };
      assert.equal(blockedErr.error.code, 'GATE_DNA_NOT_LOCKED');

      // 2. Lock DNA v1 -> enables S1..S3
      const lock1Res = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/lock`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ dna: { source: 'NICHE', fidelity: 70 } }),
      });
      assert.equal(lock1Res.status, 200);
      const lock1Body = (await lock1Res.json()) as {
        data: { dnaRecord: { version: number } };
      };
      assert.equal(lock1Body.data.dnaRecord.version, 1);

      await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'custom', topic: 'Circadian Nadir', niche: 'Science' }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/research`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/approve`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2_5/runtime`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ targetMinutes: 11, wpm: 187.41 }),
      });
      const s3Res = await fetch(`${srv.baseUrl}/api/v1/stage/3/script`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s3Res.status, 202);

      // 3. Re-locking DNA after S3 increments dna_version to 2 and marks S1..S3 DIRTY with reason "DNA changed"
      const lock2Res = await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/lock`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ dna: { source: 'NICHE', fidelity: 90 } }),
      });
      const lock2Body = (await lock2Res.json()) as {
        data: { dnaRecord: { version: number } };
      };
      assert.equal(lock2Body.data.dnaRecord.version, 2);

      for (const st of ['S1', 'S2', 'S2.5', 'S3'] as const) {
        const row = getStageRow(db, projectId, st)!;
        assert.equal(row.is_dirty, 1, `Expected ${st} to be DIRTY after DNA change`);
        assert.equal(row.error_message, 'DNA changed');
      }
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // T14 & T15: Universal injection – Run 1 (Hindi neuroscience documentary) & Run 2 (English retro-gaming explainer)
  // ===========================================================================
  it('T14 & T15 — Universal injection end-to-end: Run 1 (Hindi Devanagari 187.41 WPM FactLock) AND Run 2 (English Latin 160 WPM RetroPulse with English number normalizer, 5-beat arc, bright arcade palette) both pass all 17 audit checks, pass EMRI < 20, and export a valid Master ZIP with Channel_DNA.json', async () => {
    // Verify English number normalizer directly first
    assert.equal(
      numberToEnglishWords(187.41),
      'one hundred eighty-seven point four one'
    );
    const expandedEn = replaceDigitsInEnglishProse('Cost was $20 and 187.41 units at 25%.');
    assert.ok(expandedEn.includes('twenty dollars'));
    assert.ok(expandedEn.includes('one hundred eighty-seven point four one'));
    assert.ok(expandedEn.includes('twenty-five percent'));
    const spokenEn = normaliseEnglishSpoken('First paragraph with 187.41.');
    assert.ok(spokenEn.startsWith(', '));
    assert.equal(validateSpokenBlock(spokenEn, 'Latin').valid, true);
    assert.throws(
      () => validateSpokenBlock(spokenEn, 'KlingonScript'),
      (err: Error & { code?: string }) => err.code === 'UNSUPPORTED_LANGUAGE_SCRIPT'
    );

    const db = openDatabase(':memory:');
    const gemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${srv.token}`,
    };

    try {
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'test-key-t14-valid', projectLabel: 'Key 1' }),
      });

      // -----------------------------------------------------------------------
      // RUN 1: Hindi Neuroscience (Devanagari Box 2, 187.41 WPM, Harmon 7 phases, FactLock)
      // -----------------------------------------------------------------------
      const p1Res = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Run 1 Hindi Neuroscience',
          niche: 'Chronobiology',
          brandName: 'FactLock',
          targetDuration: 11,
          configuredWpm: 187.41,
        }),
      });
      const p1Id = ((await p1Res.json()) as { data: { project: { id: string } } }).data.project.id;
      const h1 = { ...headers, 'X-Project-Id': p1Id };

      await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/lock`, {
        method: 'POST',
        headers: h1,
        body: JSON.stringify({
          dna: {
            source: 'NICHE',
            fidelity: 80,
            language: {
              primary: 'hi',
              script: 'Devanagari',
              register: 'Investigative Hindi',
              hinglishRatio: 0,
              forbiddenLexicon: ['delve'],
              transitionWords: ['लेकिन', 'इसलिए', 'क्योंकि', 'परिणामस्वरूप'],
            },
            pacingAndMetrics: {
              wpm: 187.41,
              sentenceLengthMin: 14,
              sentenceLengthMax: 22,
              targetDurationMin: 11,
              preferredCutRangeSec: [4.5, 7.8],
            },
          },
        }),
      });

      await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: h1,
        body: JSON.stringify({ mode: 'custom', topic: 'The 3:17 AM Neural Freeze', niche: 'Chronobiology' }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/research`, { method: 'POST', headers: h1, body: '{}' });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/approve`, { method: 'POST', headers: h1, body: '{}' });
      await fetch(`${srv.baseUrl}/api/v1/stage/2_5/runtime`, {
        method: 'POST',
        headers: h1,
        body: JSON.stringify({ targetMinutes: 11, wpm: 187.41 }),
      });
      const s3Run1 = await fetch(`${srv.baseUrl}/api/v1/stage/3/script`, {
        method: 'POST',
        headers: h1,
        body: '{}',
      });
      assert.equal(s3Run1.status, 202);
      const s3Run1Body = (await s3Run1.json()) as {
        data: { script: { auditReport: { allPassed: boolean; passedCount: number } } };
      };
      assert.equal(s3Run1Body.data.script.auditReport.allPassed, true);
      assert.equal(s3Run1Body.data.script.auditReport.passedCount, 17);

      await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: h1,
        body: JSON.stringify({
          transcript: makeRealTimedTranscriptJson(200, 660),
          actualDurationSec: 660,
        }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, { method: 'POST', headers: h1, body: '{}' });
      await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, { method: 'POST', headers: h1, body: '{}' });
      await fetch(`${srv.baseUrl}/api/v1/stage/7/packaging`, { method: 'POST', headers: h1, body: '{}' });

      const zip1Res = await fetch(`${srv.baseUrl}/api/v1/export/bundle?projectId=${p1Id}`, { headers: h1 });
      assert.equal(zip1Res.status, 200);
      const zip1 = await JSZip.loadAsync(Buffer.from(await zip1Res.arrayBuffer()));
      assert.ok(Object.keys(zip1.files).includes('Channel_DNA.json'));

      // -----------------------------------------------------------------------
      // RUN 2 (T15): English Retro-Gaming Explainer (Latin Box 2, 160 WPM, custom 5-beat structure, RetroPulse, bright arcade palette)
      // -----------------------------------------------------------------------
      gemini.options.targetMinutes = 11;
      gemini.options.wpm = 160;
      gemini.options.brandName = 'RetroPulse';

      const p2Res = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Run 2 English Retro Gaming',
          niche: 'Retro gaming history',
          brandName: 'RetroPulse',
          targetDuration: 11,
          configuredWpm: 160,
        }),
      });
      const p2Id = ((await p2Res.json()) as { data: { project: { id: string } } }).data.project.id;
      const h2 = { ...headers, 'X-Project-Id': p2Id };

      await fetch(`${srv.baseUrl}/api/v1/stage/0/dna/lock`, {
        method: 'POST',
        headers: h2,
        body: JSON.stringify({
          dna: {
            source: 'NICHE',
            fidelity: 85,
            identity: {
              niche: 'Retro gaming history',
              subNiche: '16-Bit Console Hardware',
              pillars: ['Hardware Limits', 'Clever Engineering Hacks', 'Frame-Rate Proofs'],
              audiencePersona: 'Retro gaming & hardware enthusiasts',
              valueProp: 'Deep hardware nostalgia explained simply',
              differentiator: 'Oscilloscope & silicon-level visual metaphors',
            },
            language: {
              primary: 'en',
              script: 'Latin',
              codeSwitchRatio: 0,
              formality: 0.55,
            },
            voice: {
              persona: 'Conversational English hardware historian',
              toneAxes: {
                seriousPlayful: 0.45,
                fastSlow: 0.65,
                simpleTechnical: 0.6,
                warmCold: 0.35,
              },
              wpm: 160,
              sentenceLen: [12, 24],
              paragraphWords: 147,
              catchphrases: [],
              bannedWords: ['delve', 'tapestry'],
              mustUsePhrases: [],
            },
            structure: {
              formatPreset: 'CUSTOM',
              chapters: [
                { name: '1. The Arcade Mystery', sharePct: 15 },
                { name: '2. The Silicon Limits', sharePct: 20 },
                { name: '3. The Clever Hack', sharePct: 25 },
                { name: '4. The Frame-Rate Proof', sharePct: 25 },
                { name: '5. Legacy & Payoff', sharePct: 15 },
              ],
              hookStyle: 'Counter-intuitive hardware myth followed by silicon reality',
              hookSeconds: 15,
              reengageEverySec: [60, 90],
              ctaStyle: 'Final synthesis payoff',
              durationRangeMin: [8, 14],
            },
            visuals: {
              style: 'Bright arcade CRT pixel-art macro cinematography',
              palette: ['magenta', 'electric-blue', 'arcade-amber'],
              lighting: ['Bright arcade CRT glow with tungsten rim lighting'],
              cameraMotion: ['Crisp pan across circuit boards'],
              negativePrompts: ['muddy sepia', 'watermark'],
            },
          },
        }),
      });

      await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: h2,
        body: JSON.stringify({
          mode: 'custom',
          topic: 'How Super Nintendo Faked 3D Graphics',
          niche: 'Retro gaming history',
        }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/research`, { method: 'POST', headers: h2, body: '{}' });
      await fetch(`${srv.baseUrl}/api/v1/stage/2/approve`, { method: 'POST', headers: h2, body: '{}' });

      const s25Run2 = await fetch(`${srv.baseUrl}/api/v1/stage/2_5/runtime`, {
        method: 'POST',
        headers: h2,
        body: JSON.stringify({ targetMinutes: 11, wpm: 160 }),
      });
      const s25Run2Body = (await s25Run2.json()) as {
        data: { runtime: { wordBudget: { phases: unknown[] } } };
      };
      // Custom 5-beat structure from Channel DNA used!
      assert.equal(s25Run2Body.data.runtime.wordBudget.phases.length, 5);

      const s3Run2 = await fetch(`${srv.baseUrl}/api/v1/stage/3/script`, {
        method: 'POST',
        headers: h2,
        body: '{}',
      });
      assert.equal(s3Run2.status, 202);
      const s3Run2Body = (await s3Run2.json()) as {
        data: {
          script: {
            box2Text: string;
            auditReport: { allPassed: boolean; passedCount: number };
          };
        };
      };
      assert.equal(s3Run2Body.data.script.auditReport.allPassed, true);
      assert.equal(s3Run2Body.data.script.auditReport.passedCount, 17);
      assert.equal(validateSpokenBlock(s3Run2Body.data.script.box2Text, 'Latin').valid, true);

      await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: h2,
        body: JSON.stringify({
          transcript: makeRealTimedTranscriptJson(200, 660),
          actualDurationSec: 660,
        }),
      });
      await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, { method: 'POST', headers: h2, body: '{}' });
      const s6Run2 = await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, {
        method: 'POST',
        headers: h2,
        body: '{}',
      });
      const s6Run2Body = (await s6Run2.json()) as {
        data: { prompts: { prompts: Array<{ promptLine: string }> } };
      };
      // Visual direction negative additions from Channel DNA included in S6 prompts!
      assert.ok(s6Run2Body.data.prompts.prompts[0].promptLine.includes('muddy sepia'));

      const s7Run2 = await fetch(`${srv.baseUrl}/api/v1/stage/7/packaging`, {
        method: 'POST',
        headers: h2,
        body: '{}',
      });
      assert.equal(s7Run2.status, 202);

      const zip2Res = await fetch(`${srv.baseUrl}/api/v1/export/bundle?projectId=${p2Id}`, {
        headers: h2,
      });
      assert.equal(zip2Res.status, 200);
      const zip2 = await JSZip.loadAsync(Buffer.from(await zip2Res.arrayBuffer()));
      const manifest2Text = await zip2.file('Project_Manifest.json')!.async('string');
      const manifest2 = JSON.parse(manifest2Text) as {
        dnaVersion: number;
        dnaHash: string;
        channelDna: { language: { primary: string; script: string } };
      };
      assert.equal(manifest2.dnaVersion, 1);
      assert.ok(manifest2.dnaHash);
      assert.equal(manifest2.channelDna.language.primary, 'en');
      assert.equal(manifest2.channelDna.language.script, 'Latin');
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // CORE REGRESSION SUITE (Preserving all <keep_intact> invariants)
  // ===========================================================================
  it('Core Regression — Word budget, Harmon 97 weights, Model-locked slicer, Hindi normalizer, 17-point audit, Tri-node surgical repair, EMRI math, S2 2-step grounding, S4 drift rollback, S6 batching, Vault AES-256-GCM & 429 failover', async () => {
    // 1. Word budget & Harmon math
    const budget = calculateWordBudget(11, 187.41);
    assert.equal(budget.totalWords, 2062);
    assert.equal(budget.paragraphCount, 14);
    assert.equal(HARMON_PHASES.reduce((a, p) => a + p.weight, 0), 97);
    assert.equal(HARMON_WEIGHT_DENOMINATOR, 97);

    // 2. Slicer combos & UNSUPPORTED_PACING_COMBO
    const words: TranscriptWordTimestamp[] = Array.from({ length: 400 }, (_, i) => ({
      word: `शब्द_${i + 1}`,
      startSec: Number((i * 0.5).toFixed(3)),
      endSec: Number(((i + 1) * 0.5).toFixed(3)),
    }));
    const slots = sliceTranscriptTimeline({
      words,
      mode: 'MODE_2_VIDEO',
      provider: 'VEO_3_1',
      defaultClipDuration: 8,
    });
    assert.ok(slots.length > 0);
    assert.throws(
      () =>
        sliceTranscriptTimeline({
          words,
          mode: 'MODE_2_VIDEO',
          provider: 'OMNI_FLASH',
          defaultClipDuration: 15,
        }),
      (err: Error & { code?: string }) => err.code === 'UNSUPPORTED_PACING_COMBO'
    );

    // 3. Hindi normalizer
    assert.equal(numberToHindiWords(1987), 'एक हज़ार नौ सौ सत्तासी');
    const expanded = replaceDigitsInProse('लागत $20 और ₹500 में 20% का अंतर था।');
    assert.ok(expanded.includes('बीस डॉलर') && expanded.includes('पाँच सौ रुपये'));

    // 4. EMRI formula
    assert.equal(computeEmriFromVectors([1, 0], [1, 0]).emriScore, 0);
    assert.equal(computeEmriFromVectors([1, 0], [0, 1]).emriScore, 50);
    assert.equal(computeEmriFromVectors([1, 0], [-1, 0]).emriScore, 100);

    // 5. Tri-node repair & K_MAX_REPAIRS=3
    const db = openDatabase(':memory:');
    addVaultKey(db, 'test-regression-key-001', 'Primary Key', {
      keyType: 'GEMINI',
      status: 'VALID',
    });
    db.prepare(
      `INSERT INTO projects (
         id, name, niche, brand_name, target_duration, target_words, configured_wpm,
         reasoning_model, fast_model, embedding_model, active_state
       ) VALUES (
         'p-reg', 'Regression Test', 'Science', 'FactLock', 11, 2062, 187.41,
         'models/gemini-pro-latest', 'models/gemini-flash-latest', 'models/gemini-embedding-exp', 'S2.5'
       )`
    ).run();
    handleLockChannelDna({ db, projectId: 'p-reg', dna: { source: 'NICHE' } });
    for (const st of ['S0', 'S1', 'S2', 'S2.5']) {
      db.prepare(
        `INSERT OR REPLACE INTO project_stages (project_id, stage_id, payload_json, status, is_dirty)
         VALUES ('p-reg', ?, ?, 'PASSED', 0)`
      ).run(
        st,
        st === 'S2'
          ? JSON.stringify({
              topicTitle: 'Neural Clock',
              approved: true,
              verifiedClaims: [{ id: 'ev-1', claim: 'Test', institution: 'Stanford', year: '2024' }],
            })
          : st === 'S2.5'
            ? JSON.stringify({
                targetMinutes: 11,
                wpm: 187.41,
                wordBudget: budget,
                chapters: budget.phases.map((p) => ({
                  ...p,
                  chapterTitle: p.phaseName,
                  narrativeBeat: '',
                  anchorIds: [],
                })),
                selectedMetaphor: { metaphor: 'Pendulum' },
              })
            : '{}'
      );
    }

    const fakeGemini = new FakeGeminiGateway({ targetMinutes: 11, wpm: 187.41 });
    const initial = await handleGenerateAndAuditScript(db, fakeGemini, 'p-reg');
    initial.paragraphs[4].text = ', छोटा टूटा वाक्य।';
    db.prepare(`UPDATE project_stages SET payload_json = ? WHERE project_id = 'p-reg' AND stage_id = 'S3'`).run(
      JSON.stringify(initial)
    );
    await handleAuditExistingScript(db, fakeGemini, 'p-reg');
    const repaired = await handleSurgicalRepairEndpoint(db, fakeGemini, 'p-reg', {
      paragraphIndex: 4,
    });
    assert.notEqual(repaired.paragraphs[4].text, ', छोटा टूटा वाक्य।');

    // 6. Vault encryption & 429 failover
    const secretA = Buffer.alloc(32, 0xaa);
    const secretB = Buffer.alloc(32, 0xbb);
    const ct = encryptApiKey('my-secret-key-value-999', secretA);
    assert.equal(decryptApiKey(ct, secretA), 'my-secret-key-value-999');
    assert.throws(
      () => decryptApiKey(ct, secretB),
      (err: Error & { code?: string }) => err.code === 'VAULT_DECRYPT_FAILED'
    );

    addVaultKey(db, 'test-regression-key-002', 'Backup Key', {
      keyType: 'GEMINI',
      status: 'VALID',
    });
    let callCount = 0;
    const failoverOut = await executeWithKeyFailover({
      db,
      operation: async (_key, record) => {
        callCount += 1;
        if (callCount === 1) {
          const err = new Error('429 rate limit') as Error & { status?: number };
          err.status = 429;
          throw err;
        }
        return record.projectLabel;
      },
    });
    assert.equal(failoverOut.result, 'Backup Key');
  });

  // ===========================================================================
  // ACCEPTANCE SUITES E1 THROUGH E14 (Master Prompt v4 Requirements)
  // ===========================================================================

  it('E1 — Canonical timestamps & flow prompt syntax: rollover boundary cases, 3-hour zero-drift integer-ms stream, prompt-line regex check, single-formatter grep', async () => {
    // 1. Boundary cases
    assert.equal(formatTimestampTag(59.9996), '#[01-00.000]');
    assert.equal(formatTimestampTag(3599.5), '#[59-59.500]');
    assert.equal(formatTimestampTag(0.0004), '#[00-00.000]');
    assert.equal(formatTimestampTag(4503.45), '#[75-03.450]');
    assert.equal(formatRangeLabel(0, 4.5), '00:00.000 → 00:04.500');

    // 2. 3-hour zero-drift synthetic stream (10,800,000 ms)
    const TARGET_3H_MS = 3 * 60 * 60 * 1000;
    const SLICE_DUR_MS = 5000;
    const slicesCount = TARGET_3H_MS / SLICE_DUR_MS;
    let cursorMs = 0;
    for (let i = 0; i < slicesCount; i++) {
      const startMs = cursorMs;
      const endMs = startMs + SLICE_DUR_MS;
      const tag = formatTimestampTag(startMs, true);
      assert.match(tag, /^#\[\d{2,}-\d{2}\.\d{3}\]$/);
      assert.ok(!tag.includes(':'), 'Timestamp tag must have zero colons');
      cursorMs = endMs;
    }
    assert.equal(cursorMs, TARGET_3H_MS, 'Stream must end at exactly 10,800,000 ms with 0ms drift');

    // 3. Prompt-line regex check
    const promptLines = assembleFlowPrompts({
      slots: [
        {
          slotIndex: 1,
          startSec: 0,
          endSec: 5,
          startMs: 0,
          endMs: 5000,
          durationSec: 5,
          durationMs: 5000,
          actionSec: 3.5,
          actionMs: 3500,
          holdSec: 1.5,
          holdMs: 1500,
          rangeLabel: '00:00.000 → 00:05.000',
          spokenSegment: 'Introduction to quantum physics',
          wordCount: 4,
          timestampTag: '#[00-00.000]',
        },
      ],
      visualSpecs: [],
      mode: 'MODE_1_IMAGE',
      stylePrefix: 'Cinematic film still, 35mm photograph',
    });
    assert.ok(promptLines.length > 0);
    for (const p of promptLines) {
      assert.match(p.promptLine, /^#\[\d{2,}-\d{2}\.\d{3}\]\s/);
      assert.ok(p.promptLine.includes('Cinematic film still'));
    }

    // 4. Single-formatter grep: only timestamps.ts declares `export function formatTimestampTag`
    const sharedFiles = fs.readdirSync(path.resolve(process.cwd(), 'shared/rules'));
    let definitionCount = 0;
    for (const f of sharedFiles) {
      if (!f.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.resolve(process.cwd(), 'shared/rules', f), 'utf8');
      if (content.includes('export function formatTimestampTag(')) {
        definitionCount += 1;
        assert.equal(f, 'timestamps.ts', `Only timestamps.ts may define formatTimestampTag, found in ${f}`);
      }
    }
    assert.equal(definitionCount, 1);
  });

  it('E2 — Matrix parser tests: WebVTT, SRT, WhisperX, Descript, flat JSON, ElevenLabs character alignment, CSV/TSV, plain lines, tagged lines', () => {
    // 1. WebVTT (with hours, without hours, cue settings, NOTE, tags)
    const vtt = `WEBVTT
NOTE comment block

00:00.000 --> 00:02.500 position:10%
<c.bold>First</c> cue text

01:00:05.120 --> 01:00:08.500
Second cue after one hour`;
    const vttRes = parseExpressTranscript(vtt, undefined, { allowShort: true });
    assert.equal(vttRes.meta.format, 'WEBVTT');
    assert.ok(vttRes.words.length >= 7);

    // 2. SRT
    const srt = `1
00:00:00,000 --> 00:00:02,500
Hello world from SRT

2
00:00:03,000 --> 00:00:05,200
Second subtitle block`;
    const srtRes = parseExpressTranscript(srt, undefined, { allowShort: true });
    assert.equal(srtRes.meta.format, 'SRT');
    assert.ok(srtRes.words.length >= 6);

    // 3. WhisperX JSON
    const whisperX = JSON.stringify({
      segments: [
        {
          start: 0,
          end: 2.5,
          text: 'WhisperX segment',
          words: [
            { word: 'WhisperX', start: 0.1, end: 0.9 },
            { word: 'segment', start: 1.0, end: 2.2 },
          ],
        },
      ],
    });
    const wxRes = parseExpressTranscript(whisperX, undefined, { allowShort: true });
    assert.equal(wxRes.meta.format, 'WHISPERX_JSON');
    assert.equal(wxRes.words.length, 2);
    assert.equal(wxRes.words[0].word, 'WhisperX');

    // 4. Descript JSON
    const descript = JSON.stringify({
      words: [
        { word: 'Descript', start: 0.05, end: 0.8 },
        { word: 'audio', start: 0.85, end: 1.5 },
      ],
    });
    const descRes = parseExpressTranscript(descript, undefined, { allowShort: true });
    assert.equal(descRes.meta.format, 'DESCRIPT_JSON');
    assert.equal(descRes.words.length, 2);

    // 5. Flat JSON array
    const flat = JSON.stringify([
      { word: 'Flat', start: 0, end: 0.5 },
      { word: 'array', start: 0.6, end: 1.1 },
    ]);
    const flatRes = parseExpressTranscript(flat, undefined, { allowShort: true });
    assert.equal(flatRes.meta.format, 'FLAT_JSON');
    assert.equal(flatRes.words.length, 2);

    // 6. ElevenLabs / Cartesia character-level JSON
    const elabs = JSON.stringify({
      characters: ['H', 'i', ' ', 'a', 'l', 'l'],
      character_start_times_seconds: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
      character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    });
    const elabsRes = parseExpressTranscript(elabs, undefined, { allowShort: true });
    assert.equal(elabsRes.meta.format, 'ELEVENLABS_ALIGNMENT_JSON');
    assert.equal(elabsRes.words.length, 2);
    assert.equal(elabsRes.words[0].word, 'Hi');
    assert.equal(elabsRes.words[1].word, 'all');

    // 7. CSV / TSV
    const csv = `start,end,word\n0.0,0.5,Comma\n0.6,1.2,Separated`;
    const csvRes = parseExpressTranscript(csv, undefined, { allowShort: true });
    assert.equal(csvRes.meta.format, 'CSV');
    assert.equal(csvRes.words.length, 2);

    const tsv = `start\tend\tword\n0.0\t0.5\tTab\n0.6\t1.2\tSeparated`;
    const tsvRes = parseExpressTranscript(tsv, undefined, { allowShort: true });
    assert.equal(tsvRes.meta.format, 'TSV');
    assert.equal(tsvRes.words.length, 2);

    // 8. Plain timed lines & Tagged lines
    const plainLines = `[00:00.000] Plain timed line\n[00:02.500] Second line`;
    const plainRes = parseExpressTranscript(plainLines, undefined, { allowShort: true });
    assert.equal(plainRes.meta.format, 'PLAIN_TIMED_LINES');

    const taggedLines = `#[00-00.000] Tagged format line\n#[00-02.500] Next tagged line`;
    const taggedRes = parseExpressTranscript(taggedLines, undefined, { allowShort: true });
    assert.equal(taggedRes.meta.format, 'TAGGED_LINES');
  });

  it('E3 — Precision grading: WORD_EXACT_MS vs WORD_COARSE vs CUE_INTERPOLATED with proportional character weighting', () => {
    // 1. Exact ms words
    const exactWords: TranscriptWordTimestamp[] = [
      { word: 'Exact', startSec: 0.123, endSec: 0.456, startMs: 123, endMs: 456 },
      { word: 'timing', startSec: 0.489, endSec: 0.812, startMs: 489, endMs: 812 },
    ];
    assert.equal(computePrecisionGrade(exactWords, false).precisionGrade, 'WORD_EXACT_MS');

    // 2. Coarse words (multiples of 100ms or 500ms)
    const coarseWords: TranscriptWordTimestamp[] = [
      { word: 'Coarse', startSec: 0.0, endSec: 1.0, startMs: 0, endMs: 1000 },
      { word: 'timing', startSec: 1.0, endSec: 2.0, startMs: 1000, endMs: 2000 },
    ];
    assert.equal(computePrecisionGrade(coarseWords, false).precisionGrade, 'WORD_COARSE');

    // 3. Cue-interpolated: words carry estimated: true and proportional length distribution
    const cueWords = interpolateCueWordsProportional('I extraordinary elephant', 0, 3000);
    assert.equal(cueWords.length, 3);
    assert.equal(cueWords[0].word, 'I');
    assert.equal(cueWords[1].word, 'extraordinary');
    assert.equal(cueWords[2].word, 'elephant');

    // 'extraordinary' (13 chars) must have significantly larger duration than 'I' (1 char)
    const durI = cueWords[0].endMs! - cueWords[0].startMs!;
    const durExtraordinary = cueWords[1].endMs! - cueWords[1].startMs!;
    assert.ok(durExtraordinary > durI * 4, 'Proportional character weighting failed');
    for (const w of cueWords) {
      assert.equal(w.estimated, true, 'Cue-interpolated words must carry estimated: true');
    }
    assert.equal(computePrecisionGrade(cueWords, true).precisionGrade, 'CUE_INTERPOLATED');
  });

  it('E4 — Validation errors with indices: TRANSCRIPT_TOO_SHORT, TRANSCRIPT_INVALID, and TRANSCRIPT_GAP_WARNING', () => {
    // 1. TRANSCRIPT_TOO_SHORT
    assert.throws(
      () => parseExpressTranscript('[00:00.000] OneWord'),
      (err: Error & { code?: string }) => err.code === 'TRANSCRIPT_TOO_SHORT'
    );

    // 2. TRANSCRIPT_INVALID (non-monotonic) with exact offendingIndex
    const nonMonotonic = JSON.stringify([
      { word: 'First', start: 0.0, end: 1.5 },
      { word: 'Second', start: 1.6, end: 2.5 },
      { word: 'Backwards', start: 1.0, end: 2.0 }, // starts before word 1 end
    ]);
    assert.throws(
      () => parseExpressTranscript(nonMonotonic),
      (err: Error & { code?: string; offendingIndex?: number }) => {
        return err.code === 'TRANSCRIPT_INVALID' && err.offendingIndex === 2;
      }
    );

    // 3. Gap warning > 2.0s
    const withGap = JSON.stringify([
      { word: 'Before', start: 0.0, end: 1.0 },
      { word: 'Silence', start: 1.1, end: 2.0 },
      { word: 'After', start: 5.5, end: 6.5 }, // 3.5s gap
    ]);
    const gapRes = parseExpressTranscript(withGap, undefined, { allowShort: true });
    assert.equal(gapRes.meta.gaps.length, 1);
    assert.equal(gapRes.meta.gaps[0].gapMs, 3500);
    assert.equal(gapRes.meta.gaps[0].startIndex, 1);
    assert.equal(gapRes.meta.gaps[0].endIndex, 2);
  });

  it('E5 — Runtime lock = last word endMs, actual WPM, drift behavior', () => {
    const words: TranscriptWordTimestamp[] = [
      { word: 'One', startSec: 0, endSec: 0.5, startMs: 0, endMs: 500 },
      { word: 'Two', startSec: 0.6, endSec: 1.0, startMs: 600, endMs: 1000 },
      { word: 'Three', startSec: 1.1, endSec: 2.456, startMs: 1100, endMs: 2456 },
    ];
    const metrology = computeTranscriptMetrology(words, []);
    assert.equal(metrology.lockedRuntimeMs, 2456);
    assert.equal(metrology.lockedRuntimeSec, 2.456);
    assert.equal(metrology.wordCount, 3);
    // WPM = (3 / (2.456 / 60)) = 73.29
    assert.equal(metrology.actualWpm, 73.29);
  });

  it('E6 — Express pipeline gates: project with entry_mode=EXPRESS bypasses S1..S3, allows S4 lock -> S5 Storyboard', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const baseHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };

      // 1. Create Express project
      const createRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          name: 'Express Pipeline Test',
          niche: 'Cybersecurity Architecture',
          targetDuration: 10,
          entryMode: 'EXPRESS',
        }),
      });
      assert.equal(createRes.status, 201);
      const createBody = (await createRes.json()) as { data: { project: { id: string } } };
      const projectId = createBody.data.project.id;

      const pHeaders = {
        ...baseHeaders,
        'X-Project-Id': projectId,
      };

      // Missing key -> returns 409 NO_ACTIVE_API_KEY
      const noKeyRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ transcript: makeRealTimedTranscriptJson(60, 30) }),
      });
      assert.equal(noKeyRes.status, 409);

      // Add valid Gemini key
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ apiKey: 'test-key-e6-valid', projectLabel: 'Key E6' }),
      });

      // Missing DNA / Quick Style -> returns 409 GATE_DNA_NOT_LOCKED
      const noDnaRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ transcript: makeRealTimedTranscriptJson(60, 30) }),
      });
      assert.equal(noDnaRes.status, 409);

      // Lock Quick Style
      await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ niche: 'Cybersecurity Architecture' }),
      });

      // 2. Lock S4 directly without S1..S3 (60 words over 30s)
      const transcriptWords = Array.from({ length: 60 }, (_, i) => ({
        word: `word${i + 1}`,
        start: Number((i * 0.5).toFixed(3)),
        end: Number(((i + 1) * 0.5).toFixed(3)),
      }));
      const lockRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          transcript: JSON.stringify(transcriptWords),
          entryMode: 'EXPRESS',
        }),
      });
      assert.equal(lockRes.status, 200);

      // Verify S1..S3 are marked EXTERNAL_PROVIDED
      for (const st of ['S1', 'S2', 'S2.5', 'S3'] as const) {
        const row = getStageRow(db, projectId, st);
        assert.ok(row, `Stage ${st} row must exist`);
        assert.equal(row.status, 'EXTERNAL_PROVIDED');
      }

      // 3. Stage 5 Storyboard slicing succeeds
      const s5Res = await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ generationMode: 'MODE_1_IMAGE' }),
      });
      assert.equal(s5Res.status, 200);
      const s5Body = (await s5Res.json()) as { data: { storyboard: { slotCount: number } } };
      assert.ok(s5Body.data.storyboard.slotCount > 0);

      // 4. Switch to FULL mode marks S4+ DIRTY
      const switchRes = await fetch(`${srv.baseUrl}/api/v1/projects/${projectId}/entry-mode`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ entryMode: 'FULL' }),
      });
      assert.equal(switchRes.status, 200);
      assert.equal(getStageRow(db, projectId, 'S4')?.is_dirty, 1);
      assert.equal(getStageRow(db, projectId, 'S5')?.is_dirty, 1);
    } finally {
      await srv.close();
    }
  });

  it('E7 — Quick Style Channel DNA lock: locks minimal DNA with source=EXPRESS and configures visual style prefix', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const createRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${srv.token}`,
        },
        body: JSON.stringify({
          name: 'Quick Style Test',
          niche: 'Space Exploration',
          entryMode: 'EXPRESS',
        }),
      });
      const projectId = ((await createRes.json()) as { data: { project: { id: string } } }).data.project.id;
      const pHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
        'X-Project-Id': projectId,
      };

      const qsRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({
          niche: 'Space Exploration',
          visualStyle: 'Hyper-detailed astrophotography',
          stylePrefix: 'NASA James Webb telescope capture, deep space',
          negativePrompts: ['cgi', 'cartoon', 'low quality'],
        }),
      });
      assert.equal(qsRes.status, 200);
      const qsBody = (await qsRes.json()) as { data: { dnaRecord: { dna: { source: string; visuals: { style: string } } } } };
      assert.equal(qsBody.data.dnaRecord.dna.source, 'EXPRESS');
      assert.equal(qsBody.data.dnaRecord.dna.visuals.style, 'NASA James Webb telescope capture, deep space');
    } finally {
      await srv.close();
    }
  });

  it('E8 — Fuzzy script alignment: maps transcript words to script paragraphs by n-gram token overlap', () => {
    const script = `Paragraph one discussing artificial intelligence and transformers.
Paragraph two covering GPU compute clusters and memory bandwidth.
Paragraph three explaining inference latency and speculative decoding.`;

    const allWords = [
      'Paragraph', 'one', 'discussing', 'artificial', 'intelligence', 'and', 'transformers',
      'Paragraph', 'two', 'covering', 'GPU', 'compute', 'clusters', 'and', 'memory', 'bandwidth',
      'Paragraph', 'three', 'explaining', 'inference', 'latency', 'and', 'speculative', 'decoding',
    ];
    const transcriptWords: TranscriptWordTimestamp[] = allWords.map((w, i) => ({
      word: w,
      startSec: Number((i * 0.5).toFixed(3)),
      endSec: Number(((i + 1) * 0.5).toFixed(3)),
      startMs: i * 500,
      endMs: (i + 1) * 500,
    }));

    const alignment = alignScriptParagraphs(script, transcriptWords);
    assert.equal(alignment.aligned, true);
    assert.ok(alignment.confidence > 0.5);
    assert.equal(alignment.paragraphs.length, 3);
  });

  it('E9 — Stage 7 Packaging in Express Mode: generates 3 packs, derives ungrounded triples (USER_SCRIPT), and exports Master ZIP', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway({ targetMinutes: 5, wpm: 160 });
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const baseHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ apiKey: 'test-key-e9-valid', projectLabel: 'Key E9' }),
      });

      const createRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          name: 'Express Export Bundle Test',
          niche: 'Economics Explained',
          entryMode: 'EXPRESS',
        }),
      });
      const projectId = ((await createRes.json()) as { data: { project: { id: string } } }).data.project.id;
      const pHeaders = {
        ...baseHeaders,
        'X-Project-Id': projectId,
      };

      // 1. Lock Quick Style
      await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ niche: 'Economics Explained' }),
      });

      // 2. Lock Transcript (60 words over 30s)
      const transcriptWords = Array.from({ length: 60 }, (_, i) => ({
        word: `word_${i + 1}`,
        start: Number((i * 0.5).toFixed(3)),
        end: Number(((i + 1) * 0.5).toFixed(3)),
      }));
      const lockRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ transcript: JSON.stringify(transcriptWords), entryMode: 'EXPRESS' }),
      });
      assert.equal(lockRes.status, 200);

      // 3. Slice Storyboard
      const s5Res = await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ generationMode: 'MODE_1_IMAGE' }),
      });
      assert.equal(s5Res.status, 200);

      // 4. Generate Visual Prompts
      const s6Res = await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s6Res.status, 202);

      // 5. Generate Packaging
      const s7Res = await fetch(`${srv.baseUrl}/api/v1/stage/7/packaging`, {
        method: 'POST',
        headers: pHeaders,
        body: '{}',
      });
      assert.equal(s7Res.status, 202);

      // 6. Select Pack
      await fetch(`${srv.baseUrl}/api/v1/stage/7/select-pack`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ packId: 'PACK_A' }),
      });

      // 7. Export Master Bundle
      const exportRes = await fetch(`${srv.baseUrl}/api/v1/export/bundle`, {
        headers: pHeaders,
      });
      assert.equal(exportRes.status, 200);
      assert.equal(exportRes.headers.get('content-type'), 'application/zip');
      const zipBuf = Buffer.from(await exportRes.arrayBuffer());
      const zip = await JSZip.loadAsync(zipBuf);
      assert.ok(zip.file('Script_Spoken.txt'));
      assert.ok(zip.file('Synced_Transcript.srt'));
      assert.ok(zip.file('Visual_Storyboard.csv'));
      assert.ok(zip.file('Project_Manifest.json'));
      assert.ok(zip.file('Packaging_3Packs_And_SEO.json'));
    } finally {
      await srv.close();
    }
  });

  it('E10 — Thumbnail vision inspection: inlineData structured inspection and graceful UNKNOWN fallback', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway();

    // 1. Success path with mock image byte response
    const mockImageFetch = async () =>
      new Response(Buffer.from('fake-jpeg-image-bytes-data-001'), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });

    const visionResult = await inspectThumbnailVision({
      db,
      videoId: 'test-vid-001',
      gemini: fakeGemini as any,
      mockFetch: mockImageFetch as any,
    });
    assert.equal(visionResult.videoId, 'test-vid-001');
    assert.ok(visionResult.composition !== '');
    assert.ok(visionResult.confidence === 'HIGH' || visionResult.confidence === 'MEDIUM');

    // 2. Failure path with network error -> returns graceful UNKNOWN fallback
    const failingFetch = async () => {
      throw new Error('Network error fetching thumbnail');
    };
    const fallbackResult = await inspectThumbnailVision({
      db,
      videoId: 'fail-vid-002',
      gemini: fakeGemini as any,
      mockFetch: failingFetch as any,
    });
    assert.equal(fallbackResult.videoId, 'fail-vid-002');
    assert.equal(fallbackResult.composition, 'UNKNOWN');
    assert.equal(fallbackResult.confidence, 'LOW');
  });

  it('E11 — Stage 5 async job: POST /api/v1/stage/5/storyboard?async=true returns 202 and tracks job lifecycle', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const baseHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ apiKey: 'test-key-e11-valid', projectLabel: 'Key E11' }),
      });

      const createRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          name: 'Async S5 Job Test',
          niche: 'Aviation Safety',
          entryMode: 'EXPRESS',
        }),
      });
      const projectId = ((await createRes.json()) as { data: { project: { id: string } } }).data.project.id;
      const pHeaders = {
        ...baseHeaders,
        'X-Project-Id': projectId,
      };

      await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ niche: 'Aviation Safety' }),
      });

      const words = Array.from({ length: 60 }, (_, i) => ({
        word: `token_${i + 1}`,
        start: Number((i * 0.5).toFixed(3)),
        end: Number(((i + 1) * 0.5).toFixed(3)),
      }));
      const lockRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ transcript: JSON.stringify(words), entryMode: 'EXPRESS' }),
      });
      assert.equal(lockRes.status, 200);

      // Request async storyboard
      const asyncRes = await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard?async=true`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ generationMode: 'MODE_1_IMAGE' }),
      });
      assert.equal(asyncRes.status, 202);
      const asyncBody = (await asyncRes.json()) as { ok: boolean; jobId: string };
      assert.ok(asyncBody.ok);
      assert.ok(asyncBody.jobId.startsWith('job-'));

      // Check job record in database
      const jobRow = db
        .prepare(`SELECT status, progress_pct, stage_id FROM jobs WHERE id = ?`)
        .get(asyncBody.jobId) as { status: string; progress_pct: number; stage_id: string } | undefined;
      assert.ok(jobRow);
      assert.equal(jobRow.stage_id, 'S5');
      assert.ok(['RUNNING', 'DONE'].includes(jobRow.status));
    } finally {
      await srv.close();
    }
  });

  it('E12 — Naming migration: hook15s is standard, somaticHook15s supported as alias, niche neutrality in labels', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const baseHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ apiKey: 'test-key-e12-valid', projectLabel: 'Key E12' }),
      });

      const createRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ name: 'Neutral Naming Test', niche: 'Personal Finance' }),
      });
      const projectId = ((await createRes.json()) as { data: { project: { id: string } } }).data.project.id;
      const pHeaders = {
        ...baseHeaders,
        'X-Project-Id': projectId,
      };

      await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ niche: 'Personal Finance' }),
      });

      const s1Res = await fetch(`${srv.baseUrl}/api/v1/stage/1/topics`, {
        method: 'POST',
        headers: pHeaders,
        body: JSON.stringify({ mode: 'ideate' }),
      });
      const s1Body = (await s1Res.json()) as { data: { candidates: Array<{ hook15s: string }> } };
      assert.ok(s1Body.data.candidates.length > 0);
      for (const card of s1Body.data.candidates) {
        assert.ok(typeof card.hook15s === 'string', 'hook15s must be string');
      }
    } finally {
      await srv.close();
    }
  });

  it('E13 — Security & Origin Guard: 401 without bearer token, 403 origin shield, and diagnostics endpoint', async () => {
    const db = openDatabase(':memory:');
    const srv = await startTestServer({ db, mode: 'termux' });
    try {
      // 1. Missing bearer token -> 401
      const noAuthRes = await fetch(`${srv.baseUrl}/api/v1/pipeline/state`);
      assert.equal(noAuthRes.status, 401);

      // 2. Bad origin -> 403
      const badOriginRes = await fetch(`${srv.baseUrl}/api/v1/pipeline/state`, {
        headers: {
          Authorization: `Bearer ${srv.token}`,
          Origin: 'http://malicious-website.com',
        },
      });
      assert.equal(badOriginRes.status, 403);

      // 3. Diagnostics endpoint returns system status
      const diagRes = await fetch(`${srv.baseUrl}/api/v1/diagnostics`, {
        headers: { Authorization: `Bearer ${srv.token}` },
      });
      assert.equal(diagRes.status, 200);
      const diagBody = (await diagRes.json()) as {
        data: {
          runtimeMode: string;
          nodeVersion: string;
          tokenConfigured: boolean;
          database: { totalSizeBytes: number };
        };
      };
      assert.equal(diagBody.data.runtimeMode, 'termux');
      assert.equal(diagBody.data.tokenConfigured, true);
      assert.ok(diagBody.data.database.totalSizeBytes >= 0);
    } finally {
      await srv.close();
    }
  });

  it('E14 — Full End-to-End Smoke Test: Express transcript upload -> Quick Style -> S5 Storyboard -> S6 Prompts -> S7 Packaging -> Master Export ZIP', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway({ targetMinutes: 4, wpm: 150 });
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const baseHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ apiKey: 'test-key-e14-valid', projectLabel: 'Key E14' }),
      });

      // 1. Create Express project
      const pRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          name: 'E2E Express Production',
          niche: 'History of Computing',
          entryMode: 'EXPRESS',
        }),
      });
      const projectId = ((await pRes.json()) as { data: { project: { id: string } } }).data.project.id;
      const headers = {
        ...baseHeaders,
        'X-Project-Id': projectId,
      };

      // 2. Quick Style lock
      await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          niche: 'History of Computing',
          visualStyle: 'Vintage 1970s laboratory photograph',
          stylePrefix: 'Vintage archival photograph of early computing lab, 35mm grain',
        }),
      });

      // 3. Transcript Preview & Lock (>= 50 words, >= 20s)
      const vttContent = `WEBVTT

00:00.000 --> 00:07.000
In nineteen seventy-one, the microprocessor revolutionized modern computing across every scientific and industrial laboratory in the world.

00:07.200 --> 00:14.500
Engineers integrated thousands of microscopic silicon transistors onto a single miniature wafer chip that executed instructions rapidly.

00:14.800 --> 00:22.500
This breakthrough architecture paved the way for the personal computer revolution and transformed modern digital information processing forever.`;

      const previewRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ transcript: vttContent }),
      });
      assert.equal(previewRes.status, 200);

      const lockRes = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          transcript: vttContent,
          entryMode: 'EXPRESS',
          confirmEstimated: true,
        }),
      });
      assert.equal(lockRes.status, 200);

      // 4. S5 Storyboard Slicing
      const s5Res = await fetch(`${srv.baseUrl}/api/v1/stage/5/storyboard`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ generationMode: 'MODE_1_IMAGE' }),
      });
      assert.equal(s5Res.status, 200);

      // 5. S6 Prompts
      const s6Res = await fetch(`${srv.baseUrl}/api/v1/stage/6/prompts`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(s6Res.status, 202);

      // 6. S7 Packaging
      const s7Res = await fetch(`${srv.baseUrl}/api/v1/stage/7/packaging`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(s7Res.status, 202);

      // 7. Select Pack
      await fetch(`${srv.baseUrl}/api/v1/stage/7/select-pack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ packId: 'PACK_A' }),
      });

      // 8. Download Master Bundle ZIP
      const bundleRes = await fetch(`${srv.baseUrl}/api/v1/export/bundle`, {
        headers,
      });
      assert.equal(bundleRes.status, 200);
      const zipData = await bundleRes.arrayBuffer();
      const zip = await JSZip.loadAsync(zipData);
      assert.ok(zip.file('Script_Spoken.txt'));
      assert.ok(zip.file('Synced_Transcript.srt'));
      assert.ok(zip.file('Visual_Storyboard.csv'));
      assert.ok(zip.file('Packaging_3Packs_And_SEO.json'));
      assert.ok(zip.file('Channel_DNA.json'));
      assert.ok(zip.file('Project_Manifest.json'));
      const manifestJson = JSON.parse(await zip.file('Project_Manifest.json')!.async('string')) as {
        transcriptPrecisionGrade: string;
      };
      assert.equal(manifestJson.transcriptPrecisionGrade, 'CUE_INTERPOLATED');
    } finally {
      await srv.close();
    }
  });

  // ===========================================================================
  // RE-AUDIT v1.3.1 FINISHING PASS SUITES (T-U1, T-U2, T-X1..T-X7, T-P1, T-H1)
  // ===========================================================================

  it('T-U1 — decodeTranscriptBytes: UTF-8, UTF-8+BOM, UTF-16LE/BE, Devanagari, >5 MB -> TRANSCRIPT_FILE_TOO_LARGE, 0 B -> TRANSCRIPT_FILE_EMPTY, NUL -> TRANSCRIPT_FILE_NOT_TEXT', () => {
    // 1. Plain UTF-8 & Devanagari
    const devanagariText = '#[00-00.125] वैज्ञानिकों\n#[00-00.650] प्रयोगशाला';
    const utf8Bytes = new TextEncoder().encode(devanagariText);
    const d1 = decodeTranscriptBytes(utf8Bytes);
    assert.equal(d1.encoding, 'UTF-8');
    assert.equal(d1.text, devanagariText);

    // 2. UTF-8 with BOM (EF BB BF)
    const bomUtf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes]);
    const d2 = decodeTranscriptBytes(bomUtf8);
    assert.equal(d2.encoding, 'UTF-8');
    assert.equal(d2.text, devanagariText);
    assert.equal(d2.text.charCodeAt(0), '#'.charCodeAt(0));

    // 3. UTF-16LE with BOM (FF FE)
    const sampleAscii = 'WEBVTT\n00:00.000 --> 00:01.000\nHello';
    const utf16LeBytes = new Uint8Array(2 + sampleAscii.length * 2);
    utf16LeBytes[0] = 0xff;
    utf16LeBytes[1] = 0xfe;
    for (let i = 0; i < sampleAscii.length; i++) {
      const code = sampleAscii.charCodeAt(i);
      utf16LeBytes[2 + i * 2] = code & 0xff;
      utf16LeBytes[2 + i * 2 + 1] = (code >> 8) & 0xff;
    }
    const d3 = decodeTranscriptBytes(utf16LeBytes);
    assert.equal(d3.encoding, 'UTF-16LE');
    assert.equal(d3.text, sampleAscii);

    // 4. UTF-16BE with BOM (FE FF)
    const utf16BeBytes = new Uint8Array(2 + sampleAscii.length * 2);
    utf16BeBytes[0] = 0xfe;
    utf16BeBytes[1] = 0xff;
    for (let i = 0; i < sampleAscii.length; i++) {
      const code = sampleAscii.charCodeAt(i);
      utf16BeBytes[2 + i * 2] = (code >> 8) & 0xff;
      utf16BeBytes[2 + i * 2 + 1] = code & 0xff;
    }
    const d4 = decodeTranscriptBytes(utf16BeBytes);
    assert.equal(d4.encoding, 'UTF-16BE');
    assert.equal(d4.text, sampleAscii);

    // 5. Empty file -> TRANSCRIPT_FILE_EMPTY
    assert.throws(
      () => decodeTranscriptBytes(new Uint8Array(0)),
      (err: Error & { code?: string }) => err.code === 'TRANSCRIPT_FILE_EMPTY'
    );

    // 6. > 5 MB -> TRANSCRIPT_FILE_TOO_LARGE
    const over5Mb = new Uint8Array(5 * 1024 * 1024 + 10);
    over5Mb.fill(65);
    assert.throws(
      () => decodeTranscriptBytes(over5Mb),
      (err: Error & { code?: string }) => err.code === 'TRANSCRIPT_FILE_TOO_LARGE'
    );

    // 7. Binary / NUL bytes -> TRANSCRIPT_FILE_NOT_TEXT
    const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a]);
    assert.throws(
      () => decodeTranscriptBytes(binaryBytes),
      (err: Error & { code?: string }) => err.code === 'TRANSCRIPT_FILE_NOT_TEXT'
    );
  });

  it('T-U2 — Transcript upload reducer/helper: sets text, detects format & encoding, stores fileName, clears cleanly, accepts manual units override', () => {
    const jsonSample = JSON.stringify([
      { word: 'नमस्ते', start: 100, end: 450 },
      { word: 'दुनिया', start: 500, end: 950 },
    ]);
    const bytes = new TextEncoder().encode(jsonSample);
    const state1 = applyTranscriptFileUpload(
      createInitialTranscriptUploadState(),
      { name: 'voiceover_hindi.json', bytes }
    );
    assert.equal(state1.fileName, 'voiceover_hindi.json');
    assert.equal(state1.fileSizeBytes, bytes.byteLength);
    assert.equal(state1.detectedEncoding, 'UTF-8');
    assert.equal(state1.formatHint, 'FLAT_JSON');
    assert.equal(state1.shouldAutoPreview, true);
    assert.equal(state1.uploadError, null);

    const state2 = setTranscriptUnitsOverride(state1, 'SECONDS');
    assert.equal(state2.unitsOverride, 'SECONDS');

    const cleared = clearTranscriptUpload();
    assert.equal(cleared.fileName, null);
    assert.equal(cleared.transcriptText, '');
    assert.equal(cleared.unitsOverride, undefined);
  });

  it('T-X1 & T-X2 — Express checklist & inline gate fix cards: 5-step checklist order, primary button label & reason, and gate error card mappings', () => {
    const samplePreview = parseExpressTranscript(
      `WEBVTT\n\n00:00:00.000 --> 00:00:12.000\n${Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')}\n\n00:00:12.000 --> 00:00:25.000\n${Array.from({ length: 30 }, (_, i) => `token${i}`).join(' ')}`
    );

    // Step 1 unmet: missing key
    const c1 = evaluateExpressChecklist({
      hasValidGeminiKeyAndModels: false,
      hasLockedStyle: false,
      parsedPreview: null,
      generationMode: 'MODE_2_VIDEO',
      videoProvider: 'VEO_3_1',
      defaultClipDuration: 8,
      confirmEstimated: false,
    });
    assert.equal(c1.canLock, false);
    assert.equal(c1.firstUnmetStep?.id, 'GEMINI_KEY_AND_MODELS');
    assert.equal(c1.primaryButtonLabel, 'Fix: Validate Gemini Key in Vault first');
    assert.ok(c1.disabledReason && c1.disabledReason.length > 5);

    // Step 2 unmet: style not locked
    const c2 = evaluateExpressChecklist({
      hasValidGeminiKeyAndModels: true,
      hasLockedStyle: false,
      parsedPreview: null,
      generationMode: 'MODE_2_VIDEO',
      videoProvider: 'VEO_3_1',
      defaultClipDuration: 8,
      confirmEstimated: false,
    });
    assert.equal(c2.firstUnmetStep?.id, 'STYLE_LOCKED');
    assert.equal(c2.primaryButtonLabel, 'Fix: Lock a style first');

    // Step 5 unmet: CUE_INTERPOLATED without consent
    const c5 = evaluateExpressChecklist({
      hasValidGeminiKeyAndModels: true,
      hasLockedStyle: true,
      parsedPreview: samplePreview,
      generationMode: 'MODE_2_VIDEO',
      videoProvider: 'OMNI_FLASH',
      defaultClipDuration: 6,
      confirmEstimated: false,
    });
    assert.equal(c5.steps.length, 5);
    assert.equal(c5.canLock, false);
    assert.equal(c5.firstUnmetStep?.id, 'ESTIMATED_TIMING_CONSENT');

    // All met once confirmEstimated is true
    const cReady = evaluateExpressChecklist({
      hasValidGeminiKeyAndModels: true,
      hasLockedStyle: true,
      parsedPreview: samplePreview,
      generationMode: 'MODE_2_VIDEO',
      videoProvider: 'OMNI_FLASH',
      defaultClipDuration: 6,
      confirmEstimated: true,
    });
    assert.equal(cReady.canLock, true);
    assert.equal(cReady.firstUnmetStep, null);
    assert.equal(cReady.disabledReason, null);

    // T-X2: Gate error -> inline fix card mappings
    assert.equal(
      mapErrorToInlineFixCard({ code: 'GATE_DNA_NOT_LOCKED', message: 'DNA not locked' })?.actionType,
      'OPEN_QUICK_STYLE'
    );
    assert.equal(
      mapErrorToInlineFixCard({ code: 'NO_ACTIVE_API_KEY', message: 'No key' })?.actionType,
      'OPEN_VAULT'
    );
    assert.equal(
      mapErrorToInlineFixCard({ code: 'NO_USABLE_MODEL', message: 'No model' })?.actionType,
      'OPEN_VAULT'
    );
    const invCard = mapErrorToInlineFixCard({
      code: 'TRANSCRIPT_INVALID',
      message: 'Non-monotonic word at index 14',
    });
    assert.equal(invCard?.actionType, 'HIGHLIGHT_OFFENDING_WORD');
    assert.equal(invCard?.offendingIndex, 14);
    assert.equal(
      mapErrorToInlineFixCard({ code: 'TRANSCRIPT_UNITS_AMBIGUOUS', message: 'Ambiguous' })?.actionType,
      'SELECT_TIME_UNITS'
    );
  });

  it('T-X3, T-X4, T-X5, T-X6, T-X7 — Server Express endpoints: Quick Style script detection, Preview/Lock parity (<50w/<20s -> 422), Estimated consent gate (422 ESTIMATED_TIMINGS_UNCONFIRMED), and FULL->EXPRESS conversion', async () => {
    const db = openDatabase(':memory:');
    const fakeGemini = new FakeGeminiGateway();
    const srv = await startTestServer({ db, gemini: fakeGemini });
    try {
      const baseHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      };
      await fetch(`${srv.baseUrl}/api/v1/vault/keys`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ apiKey: 'test-key-tx-valid', projectLabel: 'Key TX' }),
      });

      // Create a FULL project first to also test T-X6 conversion
      const pRes = await fetch(`${srv.baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          name: 'Full To Express Conversion Test',
          niche: 'Hindi Science',
          entryMode: 'FULL',
        }),
      });
      const projectId = ((await pRes.json()) as { data: { project: { id: string } } }).data.project.id;
      const headers = { ...baseHeaders, 'X-Project-Id': projectId };

      // T-X3: Quick Style with Devanagari transcriptText prefills hi + Devanagari and NEUTRAL defaults
      const qsRes = await fetch(`${srv.baseUrl}/api/v1/stage/0/quick-style`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          niche: 'Hindi Science',
          transcriptText: 'वैज्ञानिकों ने प्रयोगशाला में कोशिकाओं का परीक्षण किया',
        }),
      });
      assert.equal(qsRes.status, 200);
      const qsBody = (await qsRes.json()) as {
        data: {
          dnaRecord: {
            dna: {
              source: string;
              language: { primary: string; script: string };
              visuals: { lighting: string[]; cameraMotion: string[] };
            };
          };
        };
      };
      assert.equal(qsBody.data.dnaRecord.dna.source, 'EXPRESS');
      assert.equal(qsBody.data.dnaRecord.dna.language.primary, 'hi');
      assert.equal(qsBody.data.dnaRecord.dna.language.script, 'Devanagari');
      assert.ok(
        !qsBody.data.dnaRecord.dna.visuals.lighting[0].includes('Cinematic volumetric'),
        'Quick Style must use neutral lighting defaults'
      );

      // T-X4: Preview and Lock parity — short transcript (10 words, 5s) fails with 422 TRANSCRIPT_TOO_SHORT on BOTH preview and lock
      const shortTranscript = JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({
          word: `शब्द_${i + 1}`,
          start: i * 0.5,
          end: (i + 1) * 0.5,
        }))
      );
      const prevShort = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ transcript: shortTranscript }),
      });
      assert.equal(prevShort.status, 422);
      const prevShortErr = (await prevShort.json()) as { error: { code: string } };
      assert.equal(prevShortErr.error.code, 'TRANSCRIPT_TOO_SHORT');

      const lockShort = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ transcript: shortTranscript, entryMode: 'EXPRESS' }),
      });
      assert.equal(lockShort.status, 422);
      const lockShortErr = (await lockShort.json()) as { error: { code: string } };
      assert.equal(lockShortErr.error.code, 'TRANSCRIPT_TOO_SHORT');

      // T-X5: Cue-interpolated VTT requires confirmEstimated: true
      const cueVtt = `WEBVTT

00:00.000 --> 00:08.000
Modern semiconductor lithography systems use extreme ultraviolet light to print billions of microscopic transistors across silicon wafers with extraordinary accuracy.

00:08.200 --> 00:16.500
High-numerical-aperture mirrors reflect thirteen point five nanometer wavelengths inside vacuum chambers to shrink circuit features below two nanometers reliably.

00:16.800 --> 00:25.000
This optical engineering milestone powers next-generation neural processors while reducing transistor switching energy across data centers worldwide.`;

      const unconfirmedLock = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          transcript: cueVtt,
          fileName: 'captions.vtt',
          entryMode: 'EXPRESS',
          confirmEstimated: false,
        }),
      });
      assert.equal(unconfirmedLock.status, 422);
      const unconfErr = (await unconfirmedLock.json()) as { error: { code: string } };
      assert.equal(unconfErr.error.code, 'ESTIMATED_TIMINGS_UNCONFIRMED');

      // Confirming estimated timings succeeds AND converts the FULL project to EXPRESS (T-X6)
      const confirmedLock = await fetch(`${srv.baseUrl}/api/v1/stage/4/transcript`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          transcript: cueVtt,
          fileName: 'captions.vtt',
          entryMode: 'EXPRESS',
          confirmEstimated: true,
        }),
      });
      assert.equal(confirmedLock.status, 200);

      // Verify S1..S3 are EXTERNAL_PROVIDED and fileName + confirmEstimated are stored in transcript_meta_json
      for (const st of ['S1', 'S2', 'S2.5', 'S3'] as const) {
        assert.equal(getStageRow(db, projectId, st)?.status, 'EXTERNAL_PROVIDED');
      }
      const pRow = db
        .prepare(`SELECT entry_mode, transcript_meta_json FROM projects WHERE id = ?`)
        .get(projectId) as { entry_mode: string; transcript_meta_json: string };
      assert.equal(pRow.entry_mode, 'EXPRESS');
      const storedMeta = JSON.parse(pRow.transcript_meta_json) as {
        fileName: string;
        confirmEstimated: boolean;
        precisionGrade: string;
      };
      assert.equal(storedMeta.fileName, 'captions.vtt');
      assert.equal(storedMeta.confirmEstimated, true);
      assert.equal(storedMeta.precisionGrade, 'CUE_INTERPOLATED');
    } finally {
      await srv.close();
    }
  });

  it('T-P1 — Five transcript parser fixes: (1) integer-ms JSON & unitsOverride, (2) nested ElevenLabs alignment, (3) tagged lines #[MM-SS.mmm] WORD_EXACT_MS + lastWordEndInferred, (4) word-per-cue VTT/SRT, (5) YouTube inline-timestamp VTT', () => {
    // 1. Integer-ms JSON [{word, start: 7143, end: 7413}, ...] -> 7.143s..7.413s, units: MILLISECONDS, grade: WORD_EXACT_MS
    const intMsJson = JSON.stringify([
      { word: 'First', start: 143, end: 612 },
      { word: 'Second', start: 650, end: 1289 },
      { word: 'Third', start: 7143, end: 7413 },
    ]);
    const p1 = parseExpressTranscript(intMsJson, undefined, { allowShort: true });
    assert.equal(p1.meta.units, 'MILLISECONDS');
    assert.equal(p1.meta.precisionGrade, 'WORD_EXACT_MS');
    assert.equal(p1.words[2].startMs, 7143);
    assert.equal(p1.words[2].endMs, 7413);
    assert.equal(p1.words[2].startSec, 7.143);
    assert.equal(p1.words[2].endSec, 7.413);

    // Also test explicit startMs/endMs keys and manual unitsOverride='SECONDS' on CSV
    const csvMs = `start,end,word\n100,450,Alpha\n500,920,Beta\n1000,1550,Gamma`;
    const pCsvAuto = parseExpressTranscript(csvMs, undefined, { allowShort: true });
    assert.equal(pCsvAuto.meta.units, 'MILLISECONDS');
    assert.equal(pCsvAuto.words[0].startMs, 100);
    const pCsvOverrideSec = parseExpressTranscript(csvMs, undefined, {
      allowShort: true,
      unitsOverride: 'SECONDS',
    });
    assert.equal(pCsvOverrideSec.meta.units, 'SECONDS');
    assert.equal(pCsvOverrideSec.words[0].startMs, 100000);

    // 2. Real ElevenLabs nested response { alignment: { characters, character_start_times_seconds, character_end_times_seconds }, normalized_alignment: {...} }
    const nestedElevenLabs = JSON.stringify({
      audio_base64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA...',
      alignment: {
        characters: ['न', 'म', 'स्', 'ते', ' ', 'भा', 'र', 'त'],
        character_start_times_seconds: [0.012, 0.085, 0.142, 0.215, 0.31, 0.385, 0.492, 0.588],
        character_end_times_seconds: [0.085, 0.142, 0.215, 0.31, 0.385, 0.492, 0.588, 0.712],
      },
      normalized_alignment: {
        characters: ['न', 'म', 'स्', 'ते', ' ', 'भा', 'र', 'त'],
        character_start_times_seconds: [0.012, 0.085, 0.142, 0.215, 0.31, 0.385, 0.492, 0.588],
        character_end_times_seconds: [0.085, 0.142, 0.215, 0.31, 0.385, 0.492, 0.588, 0.712],
      },
    });
    const p2 = parseExpressTranscript(nestedElevenLabs, undefined, { allowShort: true });
    assert.equal(p2.meta.format, 'ELEVENLABS_ALIGNMENT_JSON');
    assert.equal(p2.meta.precisionGrade, 'WORD_EXACT_MS');
    assert.equal(p2.words.length, 2);
    assert.equal(p2.words[0].word, 'नमस्ते');
    assert.equal(p2.words[1].word, 'भारत');
    assert.equal(p2.words[0].startMs, 12);
    assert.equal(p2.words[1].endMs, 712);

    // 3. Tagged lines #[MM-SS.mmm] word graded WORD_EXACT_MS with lastWordEndInferred: true
    const taggedExact = [
      '#[00-00.125] Quantum',
      '#[00-00.540] coherence',
      '#[00-01.185] sustains',
      '#[00-01.790] entanglement',
    ].join('\n');
    const p3 = parseExpressTranscript(taggedExact, undefined, { allowShort: true });
    assert.equal(p3.meta.format, 'TAGGED_LINES');
    assert.equal(p3.meta.precisionGrade, 'WORD_EXACT_MS');
    assert.equal(p3.meta.hasEstimatedWords, false);
    assert.equal(p3.words[3].lastWordEndInferred, true);
    assert.ok(p3.meta.warnings.some((w) => w.includes('lastWordEndInferred')));

    // 4. Word-per-cue VTT (>= 90% single-token cues -> word-level WORD_EXACT_MS, not CUE_INTERPOLATED)
    const wordPerCueVtt = `WEBVTT

00:00.120 --> 00:00.485
Silicon

00:00.510 --> 00:00.945
photonics

00:00.980 --> 00:01.415
accelerates

00:01.450 --> 00:01.925
optical

00:01.960 --> 00:02.475
interconnects`;
    const p4 = parseExpressTranscript(wordPerCueVtt, undefined, { allowShort: true });
    assert.equal(p4.meta.format, 'WEBVTT');
    assert.equal(p4.meta.precisionGrade, 'WORD_EXACT_MS');
    assert.equal(p4.meta.hasEstimatedWords, false);
    assert.equal(p4.words.length, 5);
    assert.equal(p4.words[0].startMs, 120);
    assert.equal(p4.words[0].endMs, 485);

    // 5. YouTube inline-timestamp WebVTT (<00:00:01.230><c> word</c>) -> word-level WORD_EXACT_MS
    const ytInlineVtt = `WEBVTT

00:00:00.100 --> 00:00:02.500
Deep <00:00:00.525><c> neural</c><00:00:01.140><c> networks</c><00:00:01.815><c> converge</c>`;
    const p5 = parseExpressTranscript(ytInlineVtt, undefined, { allowShort: true });
    assert.equal(p5.meta.format, 'WEBVTT');
    assert.equal(p5.meta.precisionGrade, 'WORD_EXACT_MS');
    assert.equal(p5.meta.hasEstimatedWords, false);
    assert.equal(p5.words.length, 4);
    assert.equal(p5.words[0].word, 'Deep');
    assert.equal(p5.words[0].startMs, 100);
    assert.equal(p5.words[0].endMs, 525);
    assert.equal(p5.words[1].word, 'neural');
    assert.equal(p5.words[1].startMs, 525);
    assert.equal(p5.words[1].endMs, 1140);
    assert.equal(p5.words[3].word, 'converge');
    assert.equal(p5.words[3].startMs, 1815);
    assert.equal(p5.words[3].endMs, 2500);
  });

  it('T-H1 — Hygiene & Neutrality Grep: no Master_Prompt files in public/, no bun.lock, no somaticHook15s / volumetric haze / hardcoded model strings in src, shared, or server', () => {
    const rootDir = process.cwd();
    assert.equal(fs.existsSync(path.join(rootDir, 'bun.lock')), false, 'bun.lock must not exist');

    const aistudioAssetsDir = path.join(rootDir, 'public/assets/aistudio');
    if (fs.existsSync(aistudioAssetsDir)) {
      const files = fs.readdirSync(aistudioAssetsDir);
      assert.equal(
        files.some((f) => f.includes('Master_Prompt')),
        false,
        'Master_Prompt asset must be removed from public/assets/aistudio'
      );
    }

    const forbiddenPatterns = [
      'somaticHook15s',
      'volumetric haze',
      'proj-alpha-01',
      'text-embedding-004',
      'LATIN_PHONETIC_MAP',
      'FALLBACK_OVERLAY_BANK',
      'synthesizeWordTimings',
      'cinematic documentary frame',
      'Documentary Niche',
      'AIza',
    ];

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          if (full.endsWith(path.join('src', 'config', 'constants.ts'))) continue;
          const content = fs.readFileSync(full, 'utf8');
          for (const pat of forbiddenPatterns) {
            assert.equal(
              content.includes(pat),
              false,
              `Forbidden string "${pat}" found in ${full}`
            );
          }
        }
      }
    }

    scanDir(path.join(rootDir, 'src'));
    scanDir(path.join(rootDir, 'shared'));
    scanDir(path.join(rootDir, 'server'));
  });
});
