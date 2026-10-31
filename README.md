# ShowRunner OS v1.3.1 — Sovereign Edge-Native Production Engine

ShowRunner OS v1.3.1 is a sovereign, edge-native multimodal pre-production engine engineered for **Android Termux (`127.0.0.1:5000`)** and modern desktop Chromium environments. It is built entirely on **Node.js 22.13+ (`node:sqlite` in WAL mode)**, **Express**, **React 19**, and the **Google Gemini TypeScript SDK (`@google/genai`)**.

---

## 1. Core Mission & Capabilities

ShowRunner OS transforms raw concepts or pre-recorded voiceovers into complete, production-ready cinematic bundles without third-party cloud dependencies, subscriptions, or mock data.

- **Canonical Timestamps & Flow Prompt Syntax**:
  - Single canonical format: `#[MM-SS.mmm]` (hash prefix, hyphen delimiter, zero colons, 3-digit millisecond precision).
  - Pure integer millisecond arithmetic across all slicing logic (`startMs`, `endMs`, `durationMs`, `actionMs`, `holdMs`).
  - Zero-drift guarantee across long-form productions (up to 3+ hours).
  - Every prompt line begins strictly with `#[MM-SS.mmm] `, followed by the DNA Visual Style Prefix, and Mode 2 prompts append `@start:#[MM-SS.mmm]`.

- **Express Transcript Mode (End-to-End Mobile & Desktop)**:
  - Upload a `.vtt`, `.srt`, `.json`, `.csv`, `.tsv`, or `.txt` file directly from Android or desktop (or paste into the editable box) without requiring Stage 1 ideation, Stage 2 research, or Stage 3 scriptwriting.
  - Guided 5-step Express Import Stepper with inline Quick Style locking (`source: 'EXPRESS'`), prefilled language/script detection (Devanagari/Latin), inline pacing selectors, and one-tap **Lock & slice**.
  - Full 10-format parser matrix with global unit detection (`SECONDS`, `MILLISECONDS`, `TIMECODE`) and manual override selector.

---

## 2. Express Transcript Mode — Complete Guide

### 2.1 Uploading Transcript Files on Android & Desktop
1. Tap **Import transcript** in the top bar (or open the **Script** hub and scroll to **Express Transcript Stepper & Runtime Lock**).
2. Tap **Upload transcript file (.vtt, .srt, .json, .csv, .tsv, .txt)** (minimum 48 px touch target) or drag-and-drop a file onto the card.
   - The file input uses an Android-safe `accept` list covering both file extensions and generic MIME types (`.vtt,.srt,.json,.csv,.tsv,.txt,text/vtt,text/plain,text/csv,text/tab-separated-values,application/json,application/x-subrip,application/octet-stream`) so Android's Files picker never greys out `.srt`, `.vtt`, or `.json` exports.
3. Client-side decoding runs via `decodeTranscriptBytes(bytes)`:
   - Supports **UTF-8** (with or without BOM), **UTF-16LE** (BOM), **UTF-16BE** (BOM), and **windows-1252** fallback; 100% Devanagari-safe.
   - Enforces a 5 MB size cap (`TRANSCRIPT_FILE_TOO_LARGE`), rejects 0-byte files (`TRANSCRIPT_FILE_EMPTY`), and blocks binary files containing NUL bytes (`TRANSCRIPT_FILE_NOT_TEXT`).
4. Once read, the text populates the editable paste box, displays **File Name**, **Size**, **Encoding**, **Detected Format**, and **Units** chips, and **auto-runs the preview parser**.
5. Optionally upload or paste your **Original script (`.txt` / `.md`)** in the second slot for deterministic n-gram paragraph alignment.

### 2.2 The 5-Step Pre-Flight Checklist & Stepper
The Express Import Stepper displays a persistent 5-step checklist at the top:
1. **Valid Gemini key + models**: Verified key in Vault + Reasoning/Fast models selected (tap **Vault** to configure).
2. **Style locked (Channel DNA or Quick Style)**: Tap **Quick Style** to open the inline sheet, prefilled with your transcript's detected language & script (`hi`/`Devanagari` or `en`/`Latin`), 4 format presets, and 6 visual style chips. Locking ticks Step 2 without leaving the screen.
3. **Transcript parsed (≥ 50 words & ≥ 20s)**: Displays format, units, precision grade, word count, locked runtime (`lastWord.endMs`), and actual WPM. Preview and Lock share identical validation rules.
4. **Generation mode + engine + duration chosen**: Inline dropdowns for Mode 1 / Mode 2 / Mode 3, Veo 3.1 (fixed 8s) / Omni Flash (4s/6s/8s/10s), showing exact min/max slot bounds from the model-locked pacing table.
5. **Estimated-timing confirmation** *(only when grade = `CUE_INTERPOLATED`)*: Explicit consent checkbox `"I understand word times are estimated from cue boundaries (±X ms)"`.

The primary action button label and reason banner always reflect the first unmet step, and once all steps are green you can tap **Lock Transcript Runtime** (followed by **Slice storyboard now**) or **Lock & slice in one tap**.

### 2.3 Precision Grades
- **`WORD_EXACT_MS`**: Word-level timestamps with millisecond resolution (`startMs % 100 !== 0` or `endMs % 100 !== 0` on ≥ 20% of words). Includes WhisperX, Descript, integer-ms JSON, nested ElevenLabs alignment, YouTube inline `<00:00:01.230>` VTT, word-per-cue VTT/SRT, and `#[MM-SS.mmm]` tagged lines.
- **`WORD_COARSE`**: Word-level timestamps rounded to whole seconds or 100ms tenths.
- **`CUE_INTERPOLATED`**: Multi-word subtitle cues without per-word timestamps. Word timings are distributed proportionally by character length (`estimated: true` on each word). Requires explicit `confirmEstimated: true` consent to lock, displays an **ESTIMATED** badge across Storyboard, Visual Prompts, and Packaging, and records `"transcriptPrecisionGrade": "CUE_INTERPOLATED"` in `Project_Manifest.json`.

### 2.4 Supported Transcript Formats (10 Formats with 5-Line Samples)

#### 1. WebVTT Multi-Word Cues (`.vtt` → `CUE_INTERPOLATED`)
```vtt
WEBVTT

00:00.000 --> 00:03.200
In nineteen seventy-one Intel introduced the first commercial microprocessor.
00:03.400 --> 00:06.800
Engineers integrated two thousand three hundred transistors onto silicon.
```

#### 2. WebVTT / SRT Word-Per-Cue (≥ 90% single-word cues → `WORD_EXACT_MS`)
```vtt
WEBVTT

00:00.120 --> 00:00.485
Silicon
00:00.510 --> 00:00.945
photonics
```

#### 3. YouTube Auto-Caption Inline-Timestamp WebVTT (`<HH:MM:SS.mmm><c>` → `WORD_EXACT_MS`)
```vtt
WEBVTT

00:00:00.100 --> 00:00:02.500
Deep <00:00:00.525><c> neural</c><00:00:01.140><c> networks</c><00:00:01.815><c> converge</c>
```

#### 4. SubRip (`.srt`)
```srt
1
00:00:00,000 --> 00:00:02,500
वैज्ञानिकों ने प्रयोगशाला में कोशिकाओं का परीक्षण किया।
2
00:00:02,800 --> 00:00:05,900
हर सेकंड लाखों विद्युत तरंगें मस्तिष्क को नियंत्रित करती हैं।
```

#### 5. WhisperX Word-Level JSON (`WHISPERX_JSON` → `WORD_EXACT_MS`)
```json
{
  "segments": [{
    "start": 0.0, "end": 1.45,
    "words": [{ "word": "Quantum", "start": 0.125, "end": 0.640 }, { "word": "coherence", "start": 0.680, "end": 1.450 }]
  }]
}
```

#### 6. Descript Word-Level JSON (`DESCRIPT_JSON` → `WORD_EXACT_MS`)
```json
{
  "words": [
    { "word": "Descript", "start": 0.055, "end": 0.625 },
    { "word": "alignment", "start": 0.660, "end": 1.340 }
  ]
}
```

#### 7. Flat JSON Array — Seconds or Integer Milliseconds (`FLAT_JSON` → `WORD_EXACT_MS`)
```json
[
  { "word": "नमस्ते", "start": 143, "end": 612 },
  { "word": "भारत", "start": 650, "end": 1289 },
  { "word": "विज्ञान", "start": 1320, "end": 1945 }
]
```

#### 8. ElevenLabs / Cartesia Character-Alignment JSON (Nested or Top-Level → `WORD_EXACT_MS`)
```json
{
  "alignment": {
    "characters": ["न", "म", "स्", "ते", " ", "भा", "र", "त"],
    "character_start_times_seconds": [0.012, 0.085, 0.142, 0.215, 0.310, 0.385, 0.492, 0.588],
    "character_end_times_seconds": [0.085, 0.142, 0.215, 0.310, 0.385, 0.492, 0.588, 0.712]
  }
}
```

#### 9. CSV / TSV (`CSV` / `TSV` → Auto or Manual Units Override)
```csv
start,end,word
0.125,0.540,Silicon
0.580,1.120,wafer
1.160,1.785,lithography
1.820,2.410,precision
```

#### 10. Canonical Tagged Lines (`#[MM-SS.mmm]` → `WORD_EXACT_MS`) & Plain Timed Lines (`[MM:SS.mmm]`)
```text
#[00-00.125] Quantum
#[00-00.540] coherence
#[00-01.185] sustains
#[00-01.790] entanglement
#[00-02.410]states
```

---

## 3. Termux Mobile Installation & Setup

### Step 1: Disable Android 12+ Phantom Process Killer (Run once via ADB)
```bash
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
adb shell settings put global settings_enable_monitor_phantom_procs false
```

### Step 2: Unzip and Install in Termux
```bash
cd $HOME
cp /sdcard/Download/showrunner-os-v1.3.1.zip .
unzip showrunner-os-v1.3.1.zip -d showrunner-os
cd showrunner-os
chmod +x scripts/*.sh
./scripts/termux-setup.sh
```

### Step 3: Start ShowRunner Daemon
```bash
./scripts/start.sh
```
Open Chrome on your Android phone and navigate to `http://127.0.0.1:5000`. Paste your Bearer token from `~/.showrunner_token` when prompted.

---

## 4. Troubleshooting & Error Matrix

| Error Code | Root Cause | Inline UI Fix / Remediation |
| :--- | :--- | :--- |
| `TRANSCRIPT_FILE_TOO_LARGE` | Uploaded transcript file exceeds 5 MB (`5,242,880` bytes). | Upload a text transcript under 5 MB or trim non-transcript metadata. |
| `TRANSCRIPT_FILE_EMPTY` | Uploaded file is 0 bytes or contains only whitespace. | Choose a non-empty `.vtt`, `.srt`, `.json`, `.csv`, `.tsv`, or `.txt` file. |
| `TRANSCRIPT_FILE_NOT_TEXT` | Uploaded file contains binary `NUL` (`0x00`) bytes (e.g., `.mp3`, `.mp4`, `.zip`). | Upload the exported text/caption file rather than raw audio/video media. |
| `TRANSCRIPT_TOO_SHORT` | Transcript has `< 50` words or `< 20` seconds total runtime (enforced identically in Preview and Lock). | Upload or paste the full voiceover transcript (at least 50 words and 20s). |
| `TRANSCRIPT_INVALID` | Non-monotonic timestamp, negative start time, or `endSec < startSec` at word index `N`. | Click **Jump to Offending Word** on the inline red card to highlight row `#N` in the preview table. |
| `TRANSCRIPT_UNITS_AMBIGUOUS` | Numeric timestamps could not be unambiguously classified as seconds vs milliseconds. | Click **Use SECONDS** or **Use MILLISECONDS** on the inline fix card (or use the `Units` dropdown). |
| `ESTIMATED_TIMINGS_UNCONFIRMED` | Locking a `CUE_INTERPOLATED` subtitle file without explicit user consent. | Check **"I understand word times are estimated from cue boundaries (±X ms)"** and lock again. |
| `GATE_DNA_NOT_LOCKED` | Attempting to lock a transcript or run a stage before locking Channel DNA or Quick Style. | Click **Open Quick Style** on the inline fix card to lock an Express style without leaving the screen. |
| `NO_ACTIVE_API_KEY` | No `VALID` Gemini API key in the Vault. | Click **Open Vault** → **Validate & Add Key**. |
| `NO_USABLE_MODEL` | No Reasoning or Fast Gemini model discovered/selected for the project. | Click **Open Vault** → **Test Key** → select discovered models. |
| `UPSTREAM_STAGE_DIRTY` | An upstream stage was modified after downstream stages were generated. | Re-run the highlighted upstream stage or use **Lock & slice in one tap**. |
| `PACKAGING_INCOMPLETE` | LLM returned `< 3` valid variants in Stage 7 after automatic retries. | Check Gemini quota in Vault and re-run Stage 7 Packaging. |
| `401 Unauthorized` | Missing or mismatched Bearer token in Termux mode. | Copy token from `~/.showrunner_token` into the unlock modal. |
| `403 Forbidden` (Origin Shield) | Request originated from an untrusted external origin in Termux mode. | Access strictly via `http://127.0.0.1:5000` or `http://localhost:5000`. |

---

## 5. Verification Commands

```bash
# 1. TypeScript static verification
npm run typecheck

# 2. Full unit & integration test suite (T1–T15, E1–E14, T-U1..T-H1)
npm test

# 3. End-to-end smoke verification (Path B + Path A + Express True-MS + Express CUE_INTERPOLATED)
npm run smoke

# 4. Production frontend build
npm run build

# 5. Security & hygiene audit
npm run check
```
