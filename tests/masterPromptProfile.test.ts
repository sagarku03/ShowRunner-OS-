import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  extractMasterPromptProfile,
  profileTargetMinutes,
  profileTargetWords,
  summariseProfile,
} from '../shared/rules/masterPromptProfile.ts';
import {
  allBatchFiles,
  allPackFiles,
  allPromptsFile,
  batchToFile,
  joinPromptLines,
  packToFile,
  safeSlug,
} from '../shared/rules/exportFiles.ts';
import { assembleFlowPrompts, type SlotVisualSpec } from '../shared/rules/translate.ts';
import { openDatabase } from '../server/db/db.ts';
import { assertStageUnlocked } from '../server/fsm/gates.ts';
import { getMasterPromptState, handleSaveMasterPrompt } from '../server/stages/s0MasterPrompt.ts';
import { getLockedChannelDna } from '../server/stages/s0bChannelDna.ts';

describe('AI Studio Master Prompt v6 — Master-Prompt-First Unlock & Prompt Quality (E1–E6)', () => {
  const evoloopedFixturePath = path.join(process.cwd(), 'tests/fixtures/masterPrompt.evolooped.txt');
  const evoloopedText = fs.readFileSync(evoloopedFixturePath, 'utf8');

  it('E1 — Deterministic extraction from masterPrompt.evolooped.txt matches all expected fields and invariants', () => {
    const profile = extractMasterPromptProfile(evoloopedText);

    // Channel & Persona
    assert.strictEqual(profile.identity.channelName?.value, 'Evolooped');
    assert.strictEqual(profile.identity.spokenChannelName?.value, 'इवोलूप्ड');
    assert.ok(profile.identity.channelUrl?.value?.includes('youtube.com/@Evolooped'));
    assert.ok(profile.identity.persona.value.includes('AURA-STICKMAN-PRODUCER'));

    // Language & Script
    assert.strictEqual(profile.language.voiceoverLanguage.value, 'Hinglish');
    assert.strictEqual(profile.language.script.value, 'Devanagari');
    assert.strictEqual(profile.language.leadingCommaRule.value, true);
    assert.strictEqual(profile.language.numbersAsWordsRule.value, true);
    assert.strictEqual(profile.language.zeroLatinRule.value, true);

    // Word Budget & Pacing
    assert.strictEqual(profile.budget.wordBudgetMin.value, 2000);
    assert.strictEqual(profile.budget.wordBudgetMax.value, 2400);
    assert.strictEqual(profile.budget.paragraphMin.value, 14);
    assert.strictEqual(profile.budget.paragraphMax.value, 16);
    assert.ok(profile.budget.wordsPerParagraph.value >= 140 && profile.budget.wordsPerParagraph.value <= 155);
    assert.strictEqual(profile.budget.wpm.value, 187.41);
    assert.strictEqual(profile.budget.hookSeconds.value, 15);
    assert.strictEqual(profile.budget.ctaKeyword.value, 'सब्सक्राइब');

    // Chapters
    assert.strictEqual(profile.chapters.length, 7);
    assert.strictEqual(profile.chapters[0].name, 'The Disruption');
    assert.strictEqual(profile.chapters[6].name, 'The Final Resolution');
    const totalShare = profile.chapters.reduce((sum, c) => sum + c.sharePct, 0);
    assert.ok(Math.abs(totalShare - 100) <= 2, `Total chapter share ${totalShare} should be approx 100%`);

    // Visuals & Style Prefix (without timestamp tag)
    assert.ok(profile.visual.stylePrefix.value.startsWith('Full-bleed 2D minimalist editorial vector art'));
    assert.ok(!profile.visual.stylePrefix.value.includes('#['), 'Style prefix must not contain timestamp tag');
    assert.ok(profile.visual.characterAnchor.value.startsWith('Minimalist stickman'));
    assert.ok(profile.visual.noFigureMarkers.some((m) => m.includes('no human figure in frame')));
    assert.ok(profile.visual.noFigureMarkers.some((m) => m.includes('no stickman in frame')));
    assert.ok(profile.visual.negativePrompts.some((n) => n.toLowerCase().includes('3d')));
    assert.strictEqual(profile.visual.noCliFlags.value, true);

    // Cuts & Recommended Mode
    assert.strictEqual(profile.pacing.cutMinSec.value, 1.0);
    assert.strictEqual(profile.pacing.cutMaxSec.value, 2.8);
    assert.strictEqual(profile.pacing.recommendedMode.value, 'MODE_1_IMAGE');

    // Banned Words hygiene: skip conditional bans like 'हमेशा' (permitted when...), include 'इतवार'
    assert.ok(
      profile.rules.bannedWords.includes('इतवार'),
      'Must contain explicit banned word इतवार'
    );
    assert.ok(
      !profile.rules.bannedWords.includes('हमेशा'),
      'Must exclude conditional ban containing "permitted"'
    );

    // Published Video Blacklist
    assert.strictEqual(profile.blacklist.length, 5);
    assert.ok(profile.blacklist[0].title.includes('The Brain Scan That Shocked Neuroscientists'));
    assert.ok(profile.blacklist[0].coreAnchors.length > 0);

    // Consistency Warnings (timeline 18:00 vs budget 2000-2400 words @ 187.41 WPM -> ~11.7m)
    assert.ok(profile.warnings.length > 0, 'Must produce chapter timeline vs word budget runtime mismatch warning');
    assert.ok(profile.warnings.some((w) => w.toLowerCase().includes('runtime') || w.toLowerCase().includes('timeline')));

    // Helpers
    assert.strictEqual(profileTargetWords(profile), 2200);
    const summary = summariseProfile(profile);
    assert.strictEqual(summary.channel, 'Evolooped (इवोलूप्ड)');
    assert.strictEqual(summary.chaptersCount, 7);
    assert.strictEqual(summary.recommendedMode, 'MODE_1_IMAGE');
  });

  it('E2 — Parse English master prompt with Latin script and longer cuts', () => {
    const englishPrompt = `
You are "CodeChronicles", a software engineering storytelling engine.
Channel: CodeChronicles (https://youtube.com/@codechronicles)
Language: English
Script: Latin
Word budget: 1500–1800 words, 10–12 paragraphs.
Speaking Pace: 160 WPM.
Visual Style: Dark cyber-noir vector aesthetic.
Style Prefix: "Dark terminal cyber-noir high-contrast vector aesthetic,"
Character Anchor: Senior programmer in black hoodie.
Cuts: 3.5 to 6.0 seconds per cut.
Image Engine: Midjourney.
Chapters:
Ch 1: The Outage [00:00 - 02:00] ~250 words
Ch 2: The Root Cause [02:00 - 06:00] ~600 words
Ch 3: The Fix [06:00 - 09:00] ~450 words
Ch 4: Lessons [09:00 - 10:30] ~250 words
Banned Words:
- synergy
- revolutionary
- delve
`;
    const profile = extractMasterPromptProfile(englishPrompt);
    assert.strictEqual(profile.identity.channelName?.value, 'CodeChronicles');
    assert.strictEqual(profile.language.voiceoverLanguage.value, 'English');
    assert.strictEqual(profile.language.script.value, 'Latin');
    assert.strictEqual(profile.budget.wordBudgetMin.value, 1500);
    assert.strictEqual(profile.budget.wordBudgetMax.value, 1800);
    assert.strictEqual(profile.budget.wpm.value, 160);
    assert.strictEqual(profile.pacing.cutMinSec.value, 3.5);
    assert.strictEqual(profile.pacing.cutMaxSec.value, 6.0);
    // Cut max is 6.0s (> 3.0s), so recommendedMode should be null (not MODE_1_IMAGE)
    assert.strictEqual(profile.pacing.recommendedMode.value, null);
    assert.strictEqual(profile.blacklist.length, 0);
    assert.ok(profile.rules.bannedWords.includes('synergy'));
  });

  it('E3 — Empty or garbage text never throws and returns safe defaults', () => {
    const emptyProfile = extractMasterPromptProfile('');
    assert.strictEqual(emptyProfile.identity.persona.provenance, 'DEFAULT');
    assert.strictEqual(emptyProfile.identity.channelName?.value, null);
    assert.strictEqual(emptyProfile.chapters.length, 0);
    assert.strictEqual(emptyProfile.rules.bannedWords.length, 0);
    assert.strictEqual(emptyProfile.blacklist.length, 0);

    const garbageProfile = extractMasterPromptProfile('Random garbage text with no structure @@##$$');
    assert.ok(garbageProfile);
    assert.strictEqual(typeof garbageProfile.budget.wordBudgetMin.value, 'number');
  });

  it('E4 — assembleFlowPrompts formatting: canonical tag, flow-natural prompt line, no CLI flags, frame types', () => {
    const slots = [
      {
        slotIndex: 1,
        startSec: 0,
        endSec: 2.5,
        durationSec: 2.5,
        actionSec: 1.75,
        holdSec: 0.75,
        timestampTag: '#[00-00.000]',
        spokenSegment: '',
        wordCount: 0,
      },
      {
        slotIndex: 2,
        startSec: 2.5,
        endSec: 4.8,
        durationSec: 2.3,
        actionSec: 1.61,
        holdSec: 0.69,
        timestampTag: '#[00-02.500]',
        spokenSegment: '',
        wordCount: 0,
      },
      {
        slotIndex: 3,
        startSec: 4.8,
        endSec: 7.0,
        durationSec: 2.2,
        actionSec: 1.54,
        holdSec: 0.66,
        timestampTag: '#[00-04.800]',
        spokenSegment: '',
        wordCount: 0,
      },
    ];

    const visualSpecs: SlotVisualSpec[] = [
      {
        slotIndex: 1,
        subjectDescription: 'standing at a crossroad looking bewildered',
        environmentDescription: 'Stark white void with two divergent asphalt paths',
        actionTrajectory: 'focal character pauses and inspects signpost',
        emotionTag: 'CONTEMPLATION',
        lightingSpec: 'Flat high key rim lighting',
        frameType: 'PROTAGONIST',
      },
      {
        slotIndex: 2,
        subjectDescription: 'Vintage mechanical stopwatch ticking aggressively',
        environmentDescription: 'Minimalist wooden desktop with harsh shadow',
        actionTrajectory: 'brass hands rotate rapidly',
        emotionTag: 'URGENCY',
        lightingSpec: 'Single directional spotlight',
        frameType: 'OBJECT',
      },
      {
        slotIndex: 3,
        subjectDescription: 'Vast desolate canyon stretching to horizon under twilight',
        environmentDescription: 'Distant rocky formations with layered mist',
        actionTrajectory: 'slow static atmospheric framing',
        emotionTag: 'AWE',
        lightingSpec: 'Cool dusk ambient fill',
        frameType: 'SCENIC',
      },
    ];

    const prompts = assembleFlowPrompts({
      slots,
      visualSpecs,
      mode: 'MODE_1_IMAGE',
      stylePrefix: 'Minimalist 2D flat vector aesthetic,',
      characterAnchor: 'Minimalist stickman figure with clean vector lines',
      flowNatural: true,
      noCliFlags: true,
      extraNegativePrompts: ['--no 3D render, low quality', '--ar 16:9'],
    });

    assert.strictEqual(prompts.length, 3);

    // Prompt 1: PROTAGONIST
    const p1 = prompts[0].promptLine;
    assert.ok(p1.startsWith('#[00-00.000]'), 'Must begin with canonical timestamp tag');
    assert.ok(p1.includes('Minimalist 2D flat vector aesthetic'));
    assert.ok(p1.includes('Minimalist stickman figure with clean vector lines'));
    assert.ok(!p1.includes('--no'), 'Must strip --no flag');
    assert.ok(!p1.includes('--ar'), 'Must strip --ar flag');
    assert.ok(p1.includes('Avoid'));
    assert.ok(!p1.includes('Subject:'), 'Flow-natural must not contain Subject: header');
    assert.ok(!p1.includes('Environment:'), 'Flow-natural must not contain Environment: header');

    // Prompt 2: OBJECT
    const p2 = prompts[1].promptLine;
    assert.ok(p2.startsWith('#[00-02.500]'));
    assert.ok(p2.includes('(no human figure in frame)'), 'OBJECT frameType must include (no human figure in frame)');

    // Prompt 3: SCENIC
    const p3 = prompts[2].promptLine;
    assert.ok(p3.startsWith('#[00-04.800]'));
    assert.ok(p3.includes('(no stickman in frame)'), 'SCENIC frameType must include (no stickman in frame)');
  });

  it('E5 — exportFiles pure module formats files correctly: 1 line + 1 blank line, no BOM, single final newline', () => {
    const lines = [
      '#[00-00.000] Style prefix. Shot description 1. Widescreen 16:9. Avoid blur.',
      '#[00-02.500] Style prefix. Shot description 2. Widescreen 16:9. Avoid blur.',
      '#[00-05.000] Style prefix. Shot description 3. Widescreen 16:9. Avoid blur.',
    ];

    const joined = joinPromptLines(lines);
    assert.ok(!joined.startsWith('\ufeff'), 'Must not have BOM');
    assert.strictEqual(joined.slice(-1), '\n', 'Must end with single newline');
    assert.notStrictEqual(joined.slice(-2), '\n\n', 'Must not end with trailing empty lines');

    const parts = joined.split('\n\n');
    assert.strictEqual(parts.length, 3, 'Must have exactly 3 prompt blocks separated by double newlines');

    const allFile = allPromptsFile(lines, 'Evolooped Channel');
    assert.strictEqual(allFile.fileName, 'evolooped-channel_all_prompts.txt');
    assert.strictEqual(allFile.content, joined);

    const batchFile = batchToFile(
      {
        batchIndex: 1,
        totalBatches: 2,
        label: 'Batch 1/2',
        promptCount: 3,
        startSlotIndex: 1,
        endSlotIndex: 3,
        prompts: lines,
        content: joined,
      },
      'Evolooped'
    );
    assert.strictEqual(batchFile.fileName, 'evolooped_batch_01.txt');
    assert.strictEqual(batchFile.content, joined);

    const packFile = packToFile(
      {
        packIndex: 1,
        fileName: 'Flow_Prompt_Pack_01.txt',
        promptCount: 3,
        startSlotIndex: 1,
        endSlotIndex: 3,
        content: joined,
      },
      'Evolooped'
    );
    assert.strictEqual(packFile.fileName, 'Flow_Prompt_Pack_01.txt');
  });

  it('E6 — Full database flow: saving Master Prompt auto-locks Channel DNA, updates project, and unlocks Stage 1', async () => {
    const db = openDatabase(':memory:');
    const projectId = 'test-proj-v6';

    db.prepare(
      `INSERT INTO api_keys (key_hash, encrypted_key, masked_key, project_label, key_type, status)
       VALUES ('hash-1', 'enc-1', 'AIzaSy...1', 'Default Label', 'GEMINI', 'VALID')`
    ).run();

    db.prepare(
      `INSERT INTO projects (id, name, niche, brand_name, target_duration, target_words, configured_wpm)
       VALUES (?, 'Test Project', 'General', 'FactLock', 11, 2062, 187.41)`
    ).run(projectId);

    // Save master prompt with skipLlmExtraction: true (offline / no API key)
    const saveRes = await handleSaveMasterPrompt({
      db,
      projectId,
      text: evoloopedText,
      skipLlmExtraction: true,
    });

    assert.ok(saveRes.masterPrompt);
    assert.strictEqual(saveRes.masterPrompt.isUniversalMode, false);

    // Verify projects table was updated by applyMasterPromptProfile
    const projRow = db
      .prepare(`SELECT niche, brand_name, target_words, target_duration, configured_wpm, generation_mode, dna_version FROM projects WHERE id = ?`)
      .get(projectId) as any;

    assert.strictEqual(projRow.brand_name, 'इवोलूप्ड');
    assert.strictEqual(projRow.target_words, 2200);
    assert.strictEqual(projRow.configured_wpm, 187.41);
    assert.strictEqual(projRow.generation_mode, 'MODE_1_IMAGE');
    assert.ok(projRow.dna_version > 0, 'dna_version must be > 0');

    // Verify Channel DNA was auto-locked with source: 'MASTER_PROMPT'
    const lockedDna = getLockedChannelDna(db, projectId);
    assert.ok(lockedDna);
    assert.strictEqual(lockedDna.dna.source, 'MASTER_PROMPT');
    assert.strictEqual(lockedDna.dna.fidelity, 100);
    assert.strictEqual(lockedDna.dna.language.primary, 'hi');
    assert.strictEqual(lockedDna.dna.language.script, 'Devanagari');
    assert.strictEqual(lockedDna.dna.structure.chapters.length, 7);

    // Verify Stage 1 is unlocked
    assert.doesNotThrow(() => {
      assertStageUnlocked(db, projectId, 'S1');
    }, 'Stage 1 must be unlocked immediately without manual DNA wizard');

    // Verify blacklist_catalog has 5 rows
    const blacklistRows = db
      .prepare(`SELECT * FROM blacklist_catalog WHERE project_id = ?`)
      .all(projectId) as any[];
    assert.strictEqual(blacklistRows.length, 5);

    // Re-saving with same prompt must NOT duplicate blacklist_catalog rows
    await handleSaveMasterPrompt({
      db,
      projectId,
      text: evoloopedText,
      skipLlmExtraction: true,
    });

    const recheckRows = db
      .prepare(`SELECT * FROM blacklist_catalog WHERE project_id = ?`)
      .all(projectId) as any[];
    assert.strictEqual(recheckRows.length, 5, 'Re-saving must not duplicate blacklist entries');
  });
});
