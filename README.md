# ShowRunner OS v1.3.0 — Sovereign Edge-Native Production Engine

ShowRunner OS v1.3.0 is a sovereign, edge-native multimodal pre-production engine engineered for **Android Termux (`127.0.0.1:5000`)** and modern desktop Chromium environments. It is built entirely on **Node.js 22.13+ (`node:sqlite` in WAL mode)**, **Express**, **React 19**, and the **Google Gemini TypeScript SDK (`@google/genai`)**.

---

## 1. Core Mission & Capabilities

ShowRunner OS transforms raw concepts or pre-recorded voiceovers into complete, production-ready cinematic bundles without third-party cloud dependencies, subscriptions, or mock data.

- **P1: Canonical Timestamps & Flow Prompt Syntax**:
  - Single canonical format: `#[MM-SS.mmm]` (hash prefix, hyphen delimiter, zero colons, 3-digit millisecond precision).
  - Pure integer millisecond arithmetic across all slicing logic (`startMs`, `endMs`, `durationMs`, `actionMs`, `holdMs`).
  - Zero-drift guarantee across long-form productions (up to 3+ hours).
  - Every prompt line begins strictly with `#[MM-SS.mmm] `, followed by the DNA Visual Style Prefix, and Mode 2 prompts append `@start:#[MM-SS.mmm]`.

- **P2: Express Transcript Mode**:
  - Upload or paste existing voiceover transcripts directly without requiring Stage 1 ideation, Stage 2 research, or Stage 3 scriptwriting.
  - Multi-format parser matrix: WebVTT, SRT, WhisperX JSON, Descript JSON, Flat JSON, ElevenLabs/Cartesia character-alignment JSON, CSV, TSV, plain timed lines, and tagged lines `#[MM-SS.mmm]`.
  - Precision grading: `WORD_EXACT_MS`, `WORD_COARSE`, and `CUE_INTERPOLATED` (using character-weighted proportional duration interpolation where every word is flagged with `estimated: true`).
  - Runtime locked to final word `endMs` (never startMs).
  - Automated non-speech token stripper (removes `[music]`, `[applause]`, `<c.color>`, tags).
  - Deterministic fuzzy script-paragraph alignment with confidence scores.
  - Quick Style Channel DNA locking with `source: 'EXPRESS'`.

- **P3: Audit Gaps Closed**:
  - Real thumbnail vision inspection via Gemini FAST tier using `inlineData` on public `i.ytimg.com` thumbnail images with local SHA256 byte caching and graceful fallback.
  - Asynchronous background jobs (HTTP 202 `{ jobId }`) with real-time WebSocket progress broadcasts.
  - Channel niche neutrality: zero hardcoded documentary labels; universal creator presets (Documentary, Explainer, Storytime, Listicle, Custom).
  - In-app System & LLM Diagnostics (`GET /api/v1/diagnostics`) with one-tap clipboard copy.

---

## 2. Termux Mobile Installation & Setup

### Step 1: Disable Android 12+ Phantom Process Killer (Run once via ADB)
```bash
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
adb shell settings put global settings_enable_monitor_phantom_procs false
```

### Step 2: Unzip and Install in Termux
If you downloaded `showrunner-os-v1.3.0.zip` on your phone:
```bash
# Move to Termux home directory
cd $HOME

# Copy from Download folder (Termux storage permission required: termux-setup-storage)
cp /sdcard/Download/showrunner-os-v1.3.0.zip .
unzip showrunner-os-v1.3.0.zip -d showrunner-os
cd showrunner-os

# Run the automated setup script
chmod +x scripts/*.sh
./scripts/termux-setup.sh
```

### Step 3: Start ShowRunner Daemon
```bash
# Starts daemon with WakeLock on 127.0.0.1:5000 and prints your Bearer token
./scripts/start.sh
```
Open Chrome or Kiwi Browser on your Android phone and navigate to:
`http://127.0.0.1:5000`
Paste your Bearer token from `~/.showrunner_token` when prompted.

---

## 3. Complete API Specification

All protected endpoints require `Authorization: Bearer <token>` in Termux mode.

### Vault & Health (Stage 0)
- `GET /api/v1/runtime` — Public runtime info (`mode`, `showPreviewBanner`, `requireBearerAuth`).
- `GET /api/v1/vault/keys` — List stored API keys with masked values and validation status.
- `POST /api/v1/vault/keys` — Add and immediately validate a Gemini or YouTube key via live 1-token call.
- `POST /api/v1/vault/keys/:id/test` — Test a specific key and discover available models.
- `DELETE /api/v1/vault/keys/:id` — Delete a key from the vault.
- `GET /api/v1/vault/discover` — Discover and filter available Reasoning, Fast, and Embedding models.
- `POST /api/v1/vault/config` — Lock project model calibration and smart tiering.
- `GET /api/v1/health/llm` — LLM status pill data (`activeKeys`, `validKeys`, `models`, `lastError`).

### Channel DNA & Master Prompt (Stage 0 & S0B)
- `GET /api/v1/stage/0/master-prompt` — Get current Master Prompt Override state.
- `POST /api/v1/stage/0/master-prompt` — Save and analyze Master Prompt (extract persona, custom chapters, banned words, negative prompts).
- `POST /api/v1/stage/0/dna/analyse` — Run 2-step grounded Channel DNA analysis on a competitor channel.
- `POST /api/v1/stage/0/dna/lock` — Lock Channel DNA (increments version, triggers downstream invalidation).
- `POST /api/v1/stage/0/dna/unlock` — Unlock Channel DNA.
- `POST /api/v1/stage/0/quick-style` — Lock minimal Express Channel DNA (`source: 'EXPRESS'`).

### Topics & Blacklist (Stage 1)
- `POST /api/v1/stage/1/topics` — Generate 10-card Topic Matrix or perform custom semantic topic alignment.
- `POST /api/v1/stage/1/lock` — Lock chosen topic and initialize project pipeline.
- `GET /api/v1/blacklist` — List banned topic anchors and phrases.
- `POST /api/v1/blacklist` — Add topic anchor to blacklist.

### Grounded Research (Stage 2 & 2.5)
- `POST /api/v1/stage/2/research` (Async 202) — Run Google Search grounded research + MMKG claim triples.
- `POST /api/v1/stage/2/approve` — Human approval gate for research claims and evidence.
- `POST /api/v1/stage/2_5/runtime` — Synthesize 7-phase Harmon architecture & word budgets.
- `PUT /api/v1/stage/2_5/runtime` — Manually edit runtime targets or chapter beats.

### Dual Script & Audit (Stage 3)
- `POST /api/v1/stage/3/script` (Async 202) — Generate Box 1 & Box 2 dual script and execute 17-point audit.
- `POST /api/v1/stage/3/audit` — Re-run 17-point audit without rewriting script.
- `POST /api/v1/stage/3/repair` (Async 202) — Tri-node surgical repair on failing paragraph.

### Transcript Lock & Storyboard (Stage 4 & 5)
- `POST /api/v1/stage/4/transcript/preview` — Parse transcript without saving, returning metrology, precision grade, and stripped tokens.
- `GET /api/v1/stage/4/transcript` — Get current locked transcript and metrology.
- `POST /api/v1/stage/4/transcript` — Lock transcript to final word endMs; evaluate 5% drift.
- `PUT /api/v1/stage/4/transcript/tokens` — Strip non-speech tokens.
- `POST /api/v1/stage/4/rollback` — One-click drift rollback and speaking pace recalibration.
- `POST /api/v1/stage/5/storyboard` (Supports `?async=true`) — Slice timeline into storyboard slots using model-locked pacing bounds.

### Prompts, Packaging & Export (Stage 6 & 7)
- `POST /api/v1/stage/6/prompts` (Async 202) — Translate storyboard slots into 30-prompt batches and 100-prompt Flow packs.
- `POST /api/v1/stage/7/packaging` (Async 202) — Generate 3-pack packaging variants, FACS facial cues, 4-tier SEO tags, and EMRI (< 20) evaluation.
- `POST /api/v1/stage/7/select-pack` — Select passing pack (Pack A/B/C).
- `GET /api/v1/export/bundle` — Download comprehensive `MasterBundle.zip`.

### System & Jobs
- `GET /api/v1/jobs/:id` — Poll background async job status (`RUNNING`, `DONE`, `FAILED`).
- `GET /api/v1/diagnostics` — System diagnostics (memory, database WAL size, uptime, keys, logs).
- `GET /api/v1/pipeline/state` — Real-time state vector across all stages.

---

## 4. Transcript Format Matrix & Sample Inputs

ShowRunner OS accepts transcripts in any of the following formats:

### 1. WebVTT (`.vtt`)
```vtt
WEBVTT

00:00.000 --> 00:02.500
In nineteen seventy-one, Intel introduced the first microprocessor.

00:02.800 --> 00:05.900
Engineers placed two thousand three hundred transistors on silicon.
```

### 2. SubRip (`.srt`)
```srt
1
00:00:00,000 --> 00:00:02,500
In nineteen seventy-one, Intel introduced the first microprocessor.

2
00:00:02,800 --> 00:00:05,900
Engineers placed two thousand three hundred transistors on silicon.
```

### 3. WhisperX Word-Level JSON
```json
{
  "segments": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "In nineteen seventy-one Intel introduced",
      "words": [
        { "word": "In", "start": 0.0, "end": 0.2 },
        { "word": "nineteen", "start": 0.25, "end": 0.8 },
        { "word": "seventy-one", "start": 0.85, "end": 1.4 },
        { "word": "Intel", "start": 1.45, "end": 1.9 },
        { "word": "introduced", "start": 1.95, "end": 2.5 }
      ]
    }
  ]
}
```

### 4. Descript Word-Level JSON
```json
{
  "words": [
    { "word": "In", "start": 0.0, "end": 0.2 },
    { "word": "nineteen", "start": 0.25, "end": 0.8 },
    { "word": "seventy-one", "start": 0.85, "end": 1.4 },
    { "word": "Intel", "start": 1.45, "end": 1.9 },
    { "word": "introduced", "start": 1.95, "end": 2.5 }
  ]
}
```

### 5. ElevenLabs / Cartesia Character-Alignment JSON
```json
{
  "characters": ["I", "n", " ", "1", "9", "7", "1"],
  "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
}
```

### 6. CSV / TSV
```csv
start,end,word
0.0,0.2,In
0.25,0.8,nineteen
0.85,1.4,seventy-one
1.45,1.9,Intel
1.95,2.5,introduced
```

### 7. Tagged Lines (`#[MM-SS.mmm]`)
```text
#[00-00.000] In
#[00-00.250] nineteen
#[00-00.850] seventy-one
#[00-01.450] Intel
#[00-01.950] introduced
```

---

## 5. Troubleshooting & Error Matrix

| Error Code / Symptom | Root Cause | Remediation |
| :--- | :--- | :--- |
| `Cannot find module '../lightningcss.android-arm64.node'` | Native lightningcss binary missing on Android Termux ARM64. | Run `./scripts/termux-setup.sh` or use `npm rebuild` / native fallback configured in `vite.config.ts`. |
| `NO_USABLE_MODEL` / "No usable model selected" | No live models discovered for the project tier. | Open **Vault** → click **Test Key** on your Gemini key → select models from discovered dropdowns. |
| `INVALID_KEY` / "Key rejected (401/403)" | Invalid Google Gemini API key or quota exceeded. | Enter a fresh key at **Vault → Validate & Add Key**. |
| `TRANSCRIPT_TOO_SHORT` | Provided transcript has fewer than 3 words. | Provide full speech transcript for voiceover. |
| `TRANSCRIPT_INVALID (at index N)` | Non-monotonic or negative timestamp at word `N`. | Inspect timestamps at indicated index in the preview table. |
| `TRANSCRIPT_REQUIRED` | Attempting to export with estimate-only transcript. | Lock real word-level timestamp transcript in Stage 4. |
| `401 Unauthorized` | Missing or invalid Bearer token in Termux mode. | Copy token from `~/.showrunner_token` and enter in UI modal. |
| `403 Forbidden` (Origin Shield) | Accessing from external domain in Termux mode. | Connect strictly via `http://127.0.0.1:5000` or `http://localhost:5000`. |
| `PACKAGING_INCOMPLETE` | LLM returned < 3 valid variants in Stage 7. | Automated retry triggers twice; ensure FAST tier key has valid quota. |
| `TypeError: Cannot read properties of undefined (reading 'persona')` | Master Prompt extraction had missing optional keys. | Fixed in v1.3.0 with `safeExtractedSettings` defaults. |

---

## 6. Verification Commands

```bash
# Verify TypeScript compile
npm run typecheck

# Run full acceptance test suite (T1–T15 + E1–E14)
npm test

# Build production bundle
npm run build

# Run security & secret leak audit
npm run check
```
