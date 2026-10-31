import assert from 'node:assert/strict';
import http from 'node:http';
import JSZip from 'jszip';
import { createShowRunnerApp } from '../server/app.ts';
import { openDatabase } from '../server/db/db.ts';
import { defaultTestFetch, FakeGeminiGateway } from '../tests/fixtures/fakeGemini.ts';

function buildFixtureTranscriptWords(totalWords = 200, durationSec = 660): string {
  const step = durationSec / totalWords;
  const words = Array.from({ length: totalWords }, (_, idx) => ({
    word: `शब्द_${idx + 1}`,
    start: Number((idx * step).toFixed(3)),
    end: Number(((idx + 1) * step).toFixed(3)),
  }));
  return JSON.stringify(words);
}

async function runPipelineFromS1ToZip(
  baseUrl: string,
  pHeaders: Record<string, string>,
  projectId: string,
  niche: string
): Promise<string[]> {
  const s1Res = await fetch(`${baseUrl}/api/v1/stage/1/topics`, {
    method: 'POST',
    headers: pHeaders,
    body: JSON.stringify({
      mode: 'custom',
      topic: 'How Hidden Compounding Traps College Budgets',
      niche,
    }),
  });
  assert.equal(s1Res.status, 202);

  const s2Res = await fetch(`${baseUrl}/api/v1/stage/2/research`, {
    method: 'POST',
    headers: pHeaders,
    body: '{}',
  });
  assert.equal(s2Res.status, 202);

  const approveRes = await fetch(`${baseUrl}/api/v1/stage/2/approve`, {
    method: 'POST',
    headers: pHeaders,
    body: '{}',
  });
  assert.equal(approveRes.status, 200);

  const s25Res = await fetch(`${baseUrl}/api/v1/stage/2_5/runtime`, {
    method: 'POST',
    headers: pHeaders,
    body: JSON.stringify({ durationPreset: '10-12', wpm: 187.41 }),
  });
  assert.equal(s25Res.status, 202);

  const s3Res = await fetch(`${baseUrl}/api/v1/stage/3/script`, {
    method: 'POST',
    headers: pHeaders,
    body: '{}',
  });
  assert.equal(s3Res.status, 202);

  const s4Res = await fetch(`${baseUrl}/api/v1/stage/4/transcript`, {
    method: 'POST',
    headers: pHeaders,
    body: JSON.stringify({
      transcript: buildFixtureTranscriptWords(240, 660),
      actualDurationSec: 660,
    }),
  });
  assert.equal(s4Res.status, 200);

  const s5Res = await fetch(`${baseUrl}/api/v1/stage/5/storyboard`, {
    method: 'POST',
    headers: pHeaders,
    body: '{}',
  });
  assert.equal(s5Res.status, 200);

  const s6Res = await fetch(`${baseUrl}/api/v1/stage/6/prompts`, {
    method: 'POST',
    headers: pHeaders,
    body: '{}',
  });
  assert.equal(s6Res.status, 202);

  const s7Res = await fetch(`${baseUrl}/api/v1/stage/7/packaging`, {
    method: 'POST',
    headers: pHeaders,
    body: '{}',
  });
  assert.equal(s7Res.status, 202);

  const zipRes = await fetch(`${baseUrl}/api/v1/export/bundle?projectId=${projectId}`, {
    headers: pHeaders,
  });
  assert.equal(zipRes.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
  const names = Object.keys(zip.files);
  assert.ok(names.includes('Project_Manifest.json'));
  assert.ok(names.includes('Channel_DNA.json'));
  assert.ok(names.includes('Flow_Prompt_Pack_01.txt'));
  return names;
}

async function runSmoke(): Promise<void> {
  console.log('[Smoke Test] Starting ShowRunner OS v1.3.0 end-to-end verification (Path B + Path A + Express)...');

  const db = openDatabase(':memory:');
  const gemini = new FakeGeminiGateway({ targetMinutes: 11, wpm: 187.41 });

  const app = createShowRunnerApp({
    db,
    runtime: {
      mode: 'termux',
      host: '127.0.0.1',
      port: 0,
      requireBearerAuth: true,
      showPreviewBanner: false,
    },
    expectedToken: 'smoke-test-bearer-token-32bytes-long',
    gemini,
    customFetch: defaultTestFetch,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer smoke-test-bearer-token-32bytes-long',
  };

  try {
    // 1. Verify bearer auth protection
    const unauth = await fetch(`${baseUrl}/api/v1/pipeline/state`);
    assert.equal(unauth.status, 401, 'Expected 401 without token');

    // 2. Validate & add Gemini key
    const keyRes = await fetch(`${baseUrl}/api/v1/vault/keys`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        apiKey: 'smoke-test-gemini-key-valid-0001',
        projectLabel: 'Smoke Test Key',
      }),
    });
    assert.equal(keyRes.status, 201);
    const keyBody = (await keyRes.json()) as { data: { valid: boolean } };
    assert.equal(keyBody.data.valid, true);

    // =========================================================================
    // SCENARIO A: Path B New Channel ("Personal finance for college students in Hinglish")
    // S0 -> S0B -> S1..S7 -> ZIP
    // =========================================================================
    const nicheB = 'Personal finance for college students in Hinglish';
    const projBRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Path B College Finance Show',
        niche: nicheB,
        brandName: 'FactLock',
        targetDuration: 11,
        configuredWpm: 187.41,
      }),
    });
    assert.equal(projBRes.status, 201);
    const projectIdB = ((await projBRes.json()) as { data: { project: { id: string } } }).data
      .project.id;
    const headersB = { ...authHeaders, 'X-Project-Id': projectIdB };

    // Calling S1 before DNA lock must return 409 GATE_DNA_NOT_LOCKED
    const prematureS1 = await fetch(`${baseUrl}/api/v1/stage/1/topics`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ mode: 'ideate', niche: nicheB }),
    });
    assert.equal(prematureS1.status, 409);

    // Run S0B Path B Niche Analysis
    const s0bNicheRes = await fetch(`${baseUrl}/api/v1/stage/0/dna/analyse-niche`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        niche: nicheB,
        language: 'hi',
        script: 'Devanagari',
        formatPreset: 'EXPLAINER',
      }),
    });
    assert.equal(s0bNicheRes.status, 202);
    const s0bNicheData = (await s0bNicheRes.json()) as {
      data: { styleOptions: Array<{ optionId: string; dna: Record<string, unknown> }> };
    };
    assert.equal(s0bNicheData.data.styleOptions.length, 3);

    // Lock chosen Style Option
    const lockBRes = await fetch(`${baseUrl}/api/v1/stage/0/dna/lock`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ dna: s0bNicheData.data.styleOptions[0].dna }),
    });
    assert.equal(lockBRes.status, 200);

    const zipFilesB = await runPipelineFromS1ToZip(baseUrl, headersB, projectIdB, nicheB);
    console.log(
      `[Smoke Test] Path B (New Channel "${nicheB}") S0 -> S0B -> S1..S7 -> ZIP PASS (${zipFilesB.length} files)`
    );

    // =========================================================================
    // SCENARIO B: Path A Existing Channel from fixture data
    // S0 -> S0B -> S1..S7 -> ZIP
    // =========================================================================
    const projARes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Path A Existing Channel Show',
        niche: 'Systems Engineering',
        brandName: 'FactLock',
        targetDuration: 11,
        configuredWpm: 187.41,
      }),
    });
    assert.equal(projARes.status, 201);
    const projectIdA = ((await projARes.json()) as { data: { project: { id: string } } }).data
      .project.id;
    const headersA = { ...authHeaders, 'X-Project-Id': projectIdA };

    const s0bChannelRes = await fetch(`${baseUrl}/api/v1/stage/0/dna/analyse-channel`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        channelInput: '@SystemsLabFixture',
        depth: 'STANDARD',
        manualVideos: Array.from({ length: 8 }, (_, idx) => ({
          videoId: `fixvid0000${idx + 1}`,
          title: `Systems Engineering Outlier Study #${idx + 1}`,
          viewCount: (idx + 1) * 50000,
          durationSec: 660,
          publishedAt: `2025-01-0${idx + 1}T00:00:00Z`,
        })),
      }),
    });
    assert.equal(s0bChannelRes.status, 202);
    const s0bChannelData = (await s0bChannelRes.json()) as {
      data: { candidateDna: Record<string, unknown> };
    };

    const lockARes = await fetch(`${baseUrl}/api/v1/stage/0/dna/lock`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ dna: s0bChannelData.data.candidateDna }),
    });
    assert.equal(lockARes.status, 200);

    const zipFilesA = await runPipelineFromS1ToZip(
      baseUrl,
      headersA,
      projectIdA,
      'Systems Engineering'
    );
    console.log(
      `[Smoke Test] Path A (Existing Channel fixture) S0 -> S0B -> S1..S7 -> ZIP PASS (${zipFilesA.length} files)`
    );

    // =========================================================================
    // SCENARIO C: Express Path (True-ms JSON -> Quick Style -> Omni 6s -> Prompts regex -> S7 -> ZIP)
    // =========================================================================
    const projCRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Express True-MS Smoke',
        niche: 'Quantum Computing',
        entryMode: 'EXPRESS',
      }),
    });
    assert.equal(projCRes.status, 201);
    const projectIdC = ((await projCRes.json()) as { data: { project: { id: string } } }).data.project.id;
    const headersC = { ...authHeaders, 'X-Project-Id': projectIdC };

    const qsRes = await fetch(`${baseUrl}/api/v1/stage/0/quick-style`, {
      method: 'POST',
      headers: headersC,
      body: JSON.stringify({
        niche: 'Quantum Computing',
        stylePrefix: 'Macro cryostat dilution refrigerator photography, 35mm lens',
      }),
    });
    assert.equal(qsRes.status, 200);

    const exactMsWords = Array.from({ length: 65 }, (_, i) => ({
      word: `qubit_${i + 1}`,
      start: Number((i * 0.413 + 0.017).toFixed(3)),
      end: Number(((i + 1) * 0.413).toFixed(3)),
    }));
    const s4CRes = await fetch(`${baseUrl}/api/v1/stage/4/transcript`, {
      method: 'POST',
      headers: headersC,
      body: JSON.stringify({ transcript: JSON.stringify(exactMsWords), entryMode: 'EXPRESS' }),
    });
    assert.equal(s4CRes.status, 200);

    const s5CRes = await fetch(`${baseUrl}/api/v1/stage/5/storyboard`, {
      method: 'POST',
      headers: headersC,
      body: JSON.stringify({ generationMode: 'MODE_2_VIDEO', videoProvider: 'OMNI_FLASH', defaultClipDuration: 6 }),
    });
    assert.equal(s5CRes.status, 200);

    const s6CRes = await fetch(`${baseUrl}/api/v1/stage/6/prompts`, {
      method: 'POST',
      headers: headersC,
      body: '{}',
    });
    assert.equal(s6CRes.status, 202);
    const s6CBody = (await s6CRes.json()) as { data: { prompts: { prompts: Array<{ promptLine: string }> } } };
    for (const p of s6CBody.data.prompts.prompts) {
      assert.match(p.promptLine, /^#\[\d{2,}-\d{2}\.\d{3}\]\s/);
    }

    const s7CRes = await fetch(`${baseUrl}/api/v1/stage/7/packaging`, {
      method: 'POST',
      headers: headersC,
      body: '{}',
    });
    assert.equal(s7CRes.status, 202);

    const zipCRes = await fetch(`${baseUrl}/api/v1/export/bundle?projectId=${projectIdC}`, {
      headers: headersC,
    });
    assert.equal(zipCRes.status, 200);
    console.log('[Smoke Test] Scenario C (Express True-MS + Omni 6s + Prompt Regex + ZIP) PASS');

    // =========================================================================
    // SCENARIO D: Express CUE_INTERPOLATED VTT flagged end-to-end
    // =========================================================================
    const projDRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Express Cue Interpolated Smoke',
        niche: 'Semiconductor Fabrication',
        entryMode: 'EXPRESS',
      }),
    });
    const projectIdD = ((await projDRes.json()) as { data: { project: { id: string } } }).data.project.id;
    const headersD = { ...authHeaders, 'X-Project-Id': projectIdD };

    await fetch(`${baseUrl}/api/v1/stage/0/quick-style`, {
      method: 'POST',
      headers: headersD,
      body: JSON.stringify({ niche: 'Semiconductor Fabrication' }),
    });

    const vttD = `WEBVTT

00:00.000 --> 00:08.000
Extreme ultraviolet lithography uses laser-produced tin plasma droplets to pattern nanometer-scale integrated circuits on silicon wafers.

00:08.200 --> 00:16.500
Multilayer Bragg mirrors reflect thirteen point five nanometer light inside a high-vacuum chamber with sub-nanometer alignment precision.

00:16.800 --> 00:25.000
Every modern processor relies on these optical systems to pack billions of transistors into a single square centimeter.`;

    // 1) Without confirmEstimated -> 422 ESTIMATED_TIMINGS_UNCONFIRMED
    const s4DUnconfirmed = await fetch(`${baseUrl}/api/v1/stage/4/transcript`, {
      method: 'POST',
      headers: headersD,
      body: JSON.stringify({ transcript: vttD, entryMode: 'EXPRESS' }),
    });
    assert.equal(s4DUnconfirmed.status, 422);

    // 2) With confirmEstimated: true -> 200 OK
    const s4DRes = await fetch(`${baseUrl}/api/v1/stage/4/transcript`, {
      method: 'POST',
      headers: headersD,
      body: JSON.stringify({
        transcript: vttD,
        fileName: 'semiconductor_captions.vtt',
        confirmEstimated: true,
        entryMode: 'EXPRESS',
      }),
    });
    assert.equal(s4DRes.status, 200);
    const s4DBody = (await s4DRes.json()) as {
      data: { transcript: { meta: { precisionGrade: string; hasEstimatedWords: boolean; fileName: string } } };
    };
    assert.equal(s4DBody.data.transcript.meta.precisionGrade, 'CUE_INTERPOLATED');
    assert.equal(s4DBody.data.transcript.meta.hasEstimatedWords, true);
    assert.equal(s4DBody.data.transcript.meta.fileName, 'semiconductor_captions.vtt');
    console.log('[Smoke Test] Scenario D (Express CUE_INTERPOLATED VTT consent gate + metadata) PASS');

    console.log('[Smoke Test] PASS — Path B, Path A, Express True-MS, and Express CUE_INTERPOLATED verified.');
  } finally {
    server.close();
  }
}

runSmoke().catch((err) => {
  console.error('[Smoke Test] FAILED:', err);
  process.exit(1);
});
