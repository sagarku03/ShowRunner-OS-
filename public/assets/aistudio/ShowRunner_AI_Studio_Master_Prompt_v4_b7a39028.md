

<role_and_mission>
You are a principal engineer finishing ShowRunner OS v1.3.0 (edge-native YouTube pre-production engine; Termux `127.0.0.1:5000`; Node 22.13+ `node:sqlite`; Express + React; Gemini via `@google/genai`).
The build already contains: key validation + health, error mapping, Master Prompt Override, Channel DNA & Style Lock (channel / niche / reference paths), model-locked pacing, 2-step grounded research, tri-node repair, EMRI, async jobs. Remaining problems are listed below. Goals of this pass:
 (P1) restore PRD-correct timestamps and Flow prompt syntax (critical regression),
 (P2) add **Express Transcript Mode**: a user who already has topic, script and voiceover done uploads or pastes only a word-by-word, millisecond-level timestamp transcript and continues straight into scene slicing, prompts and packaging,
 (P3) close the remaining audit gaps (thumbnail vision, S5 job, naming, README, hygiene),
 (P4) prove everything with real command outputs.
Do NOT rewrite working parts. Do NOT regress <keep_intact>. Finish all parts in this single session; no placeholders, TODOs or mock data in runtime code.
</role_and_mission>

<source_of_truth>
Priority: (1) this prompt, (2) ShowRunner OS PRD v1.3, (3) Final Master Plan, (4) Research 1-5 / AutoEditer / Flow Extension notes. Numbers stated here win; tunables live in `src/config/constants.ts`.
</source_of_truth>

<keep_intact>
No fake data / no hard-coded model names / no silent fallbacks; key validation, health pill, `mapGeminiError`, `NO_USABLE_MODEL`; Master Prompt Override and its injection; Channel DNA engine (Paths A/B/C), Style Lock, DNA consumption in stages, similarity guard; bearer-token auth, origin shield, 127.0.0.1 bind; WS `/ws/ipc`; AES-256-GCM vault; WAL schema (additive migrations only); model-locked pacing table (unknown combos throw); EMRI formula/gate (<20); 2-step grounded S2 + evidence table + approve gate; tri-node repair K_MAX_REPAIRS=3; JUDGE_UNAVAILABLE; drift rollback (when a target exists); jobs/202; secret scan; the improved VTT/SRT/JSON parser (extend it, never weaken it). All existing tests keep passing, except tests that asserted the wrong timestamp format (fix those, see P1).
</keep_intact>

<part_P1_timestamp_and_prompt_syntax>
P1.1 **Single canonical timestamp module.** Re-export `shared/rules/timestamps.ts` from `shared/rules/index.ts` and DELETE the second `formatTimestampTag` in `slicer.ts`. Canonical output is `#[MM-SS.mmm]` (hyphen between minutes and seconds, exactly 3 ms digits, `#` prefix, zero colons), built from INTEGER milliseconds so `59.9996 s` → `#[01-00.000]`, never `#[00-60.000]`. Minutes may exceed 59 (`#[75-03.450]`); no hours field. Provide `formatTimestampTag(ms|sec)`, `formatRangeLabel(startMs,endMs)` (human display only, e.g. `01:23.450 → 01:27.100`, never used in prompts or filenames), `parseTimestampToMs`.
P1.2 **Integer milliseconds internally.** Word and slot times are stored and computed as integer ms (`startMs`, `endMs`); seconds are derived only for display. Slicer boundaries, T_action = 0.70 × T_slot, hold, drift and WPM all computed on integer ms (no float accumulation). Public API payloads expose both `startMs/endMs` and `startSec/endSec`.
P1.3 **Flow prompt line syntax (PRD S6).** Each prompt line = `#[MM-SS.mmm]` (slot START time) + space + `[Style Prefix]` + `[Subject & Action]` + `[Environment]` + `[Camera Motion]` + `[Residual Hold]` + negative matrix; single line, no newlines. The exact string `#[MM-SS.mmm]` must be the first characters of every prompt line in batch cards, 100-packs, `.txt` downloads, ZIP export and WS push. Mode 2 additionally emits the `@start:#[MM-SS.mmm]` video reference per PRD. Slot durations/ranges live in storyboard metadata, not in the prompt line.
P1.4 **Style prefix from DNA, not hard-coded.** Remove the literal "16:9 widescreen ultra-detailed cinematic documentary frame" and the hard-coded "chiaroscuro cyan/violet" lighting. Style prefix = `dna.visual.stylePrefix` (or the format preset default from constants); lighting from DNA/visual preference; fallback only to a neutral constant `NEUTRAL_STYLE_PREFIX` defined in constants (and shown in UI as "Default style – set DNA to customise"). Aspect ratio from DNA.
P1.5 **Tests rewritten to the PRD**: `59.9996 → #[01-00.000]`, `3599.5 → #[59-59.500]`, `0.0004 → #[00-00.000]`, `4503.45 → #[75-03.450]`; every prompt line in S6 output (batches, packs, ZIP, WS) matches `^#\[\d{2,}-\d{2}\.\d{3}\] `; a grep test fails the build if a second timestamp formatter exists.
</part_P1_timestamp_and_prompt_syntax>

<part_P2_express_transcript_mode>
**Goal:** user already has topic + script + voiceover and has extracted a word-level timestamp transcript (3-digit ms). They upload/paste ONLY that transcript and continue: S5 storyboard → S6 prompts → S7 packaging → export. No S1–S3 required.

P2.1 **Entry points.**
 - First-run wizard (after API key step): new choice card **"I already have my voiceover transcript (Express)"** next to the existing channel / niche / references paths.
 - Also a persistent "Import transcript" button on the Transcript/Storyboard screen and on the project switcher ("New project → Express").
 - `POST /api/v1/stage/4/transcript` accepts `{mode:"EXPRESS", transcript (text, or multipart file up to 5 MB), scriptText?, title?, niche?, language?, targetMinutes?}`; project is created with `entry_mode='EXPRESS'`.
P2.2 **Accepted transcript formats (auto-detected, never guessed silently).** WebVTT, SRT, JSON (WhisperX `segments[].words[]`, Descript `words[]`, flat `[{word,start,end}]`, `{text,start,end}`, `{start_time,end_time}`, ms ints vs seconds), **ElevenLabs/Cartesia alignment JSON** (character-level `characters[]` + `character_start_times_seconds[]` / `character_end_times_seconds[]` → aggregate to words by whitespace; Devanagari-safe), CSV/TSV (`word,start,end` with or without header), plain lines `start end word` / `word start end`, and tagged lines `#[MM-SS.mmm] word` (hyphen format; only start times → end of word = next word start, last word end required or inferred as start + median word duration and flagged). Time formats: `HH:MM:SS.mmm`, `MM:SS.mmm`, decimal seconds, integer ms (detected by magnitude and an explicit "units" selector in the UI as override). Show the detected format + units in a confirmation chip; user can override.
P2.3 **Precision grading (no fabrication).** After parsing compute `precisionGrade`:
 - `WORD_EXACT_MS` — word-level times, ≥ 90% of timestamps carry non-zero millisecond digits (true 3-digit ms).
 - `WORD_COARSE` — word-level but rounded (to 0.1 s / 1 s / 10 ms): allowed, with warning "timestamps are coarse; cuts may be off by up to X ms".
 - `CUE_INTERPOLATED` — only cue/sentence-level times (typical VTT/SRT): allowed ONLY after the user confirms; words are interpolated proportionally by character count (not evenly by word count) and every interpolated word carries `estimated:true`; badge "ESTIMATED" shown in UI and exported metadata; cut points are snapped to cue boundaries first.
 Never present estimated times as exact. Grade is stored and shown on every downstream screen.
P2.4 **Validation (typed errors with index):** `TRANSCRIPT_TOO_SHORT` (< 50 words or < 20 s), `TRANSCRIPT_INVALID` (NaN/negative/start≥end/non-monotonic/overlap > 50 ms), `TRANSCRIPT_GAP_WARNING` (silences > 2 s listed, not blocking), `TRANSCRIPT_UNITS_AMBIGUOUS` (asks user). Normalise: trim, Unicode NFC, strip `<c>` / `[music]` / `(laughs)` / `♪` tokens (listed in a removable "non-speech tokens" panel), keep punctuation for boundary detection. Language/script auto-detected from the text (`Devanagari` / `Latin` / other) and shown for confirmation; sets `language.script` for the project.
P2.5 **Runtime lock + metrology.** `lockedRuntimeMs = last word endMs` (never start). Compute `actualWpm = words / (lockedRuntimeMs/60000)`, word count, avg/median word duration, silence stats, estimated paragraph/scene counts per generation mode. If `targetMinutes` was provided, compute drift and offer the existing rollback; in Express mode with no target there is no drift check and no S3 rollback (UI hides it) – only WPM info. Save actual WPM to the project profile.
P2.6 **Optional script text.** User may paste the original script (any language). If provided, align transcript words to script paragraphs by deterministic fuzzy token alignment (code, not LLM) to give Box 1/Box 2 views and paragraph-aware scene boundaries; alignment confidence is shown; if confidence < threshold the script is ignored with a notice. If not provided, Box 1 is reconstructed from the transcript text only (labelled "reconstructed from transcript").
P2.7 **Gates & state.** Add FSM state value `EXTERNAL_PROVIDED` for S1, S2, S2.5, S3 when entry_mode = EXPRESS (visible in UI as "Provided externally"); S4 completes on transcript lock; S5–S7 gates work unchanged. `assertStagePrerequisites` must not demand S1–S3 payloads in Express mode but still demands: valid key/models, locked DNA OR **Quick Style**, and a locked transcript. Replacing the transcript later marks S5–S7 DIRTY. Switching an Express project to full mode is allowed (S1–S3 become runnable and mark S4+ DIRTY).
P2.8 **Quick Style (minimal DNA for Express).** If no DNA is locked, show a 5-field sheet: niche (free text), format preset, language/script (prefilled from transcript), visual style (free text + 6 preset chips), brand name (optional). Saves a lightweight DNA with `source:"EXPRESS"` and locks it in one tap. A full Channel DNA analysis can be run later (re-lock = new version + DIRTY).
P2.9 **Topic/title for packaging (S7) without S1/S2.** Ask for an optional working title/topic; if blank, derive "Topic summary" from the transcript with TIER_FAST (schema-validated, labelled "derived from your script"). S7 uses: transcript first 30 s for EMRI; S-P-O triples extracted from the transcript by an **ungrounded** LLM step (`claimsSource:"USER_SCRIPT"`, labelled "unverified – from your script, not fact-checked") when S2 triples don't exist. No fabricated citations; no "verified" badge in Express mode.
P2.10 **Express UI flow (mobile first).** Paste/upload card (drag-drop + paste box + file picker + sample format helper) → detected format/units/precision chips → preview table (first 20 words with ms, last 5 words, stats) → warnings → optional script paste → Quick Style (if needed) → generation mode + engine/duration (existing pacing dropdowns) → **Lock transcript & continue** → Storyboard (S5) → Prompts (S6) → Packaging (S7) → Export. A banner "Express mode: S1–S3 provided externally" with a "Switch to full pipeline" link.
P2.11 **API additions (under `/api/v1`)**: `POST stage/4/transcript/preview` (parse + validate + grade, no state change), `POST stage/4/transcript` (lock; 202 job only if LLM steps requested, else 200), `POST stage/0/quick-style`, `GET stage/4/transcript` (words, stats, grade), `PUT stage/4/transcript/tokens` (include/exclude non-speech tokens). DB additive: `projects.entry_mode TEXT DEFAULT 'FULL'`, `transcript_meta_json` (format, units, precisionGrade, warnings, scriptAlignment).
</part_P2_express_transcript_mode>

<part_P3_remaining_gaps>
P3.1 **Thumbnail vision for real (S0B Path A/C).** Fetch each sampled video's thumbnail image bytes (public `i.ytimg.com`, max size/timeouts), send as `inlineData` to the FAST tier for thumbnail layer extraction (composition, face/object, palette computed from pixels by code where possible, overlay text OCR via model). If fetch/vision fails → thumbnail layer `UNKNOWN`/LOW confidence, never invented. Cache bytes hash only (not images) in DB.
P3.2 **S5 storyboard job-based** (202 + `/jobs/:id` + WS events) when it calls the LLM; deterministic slicing alone may stay synchronous but must stream progress for > 500 slots.
P3.3 **Neutral naming.** Rename `somaticHook15s` → `hook15s` (DB + types + UI + tests, with migration reading old key). Audit C15 label becomes "Emotional Engagement & Sensory Empathy (LLM Judge)" unless DNA preset = DOCUMENTARY (then "Somatic Friction & Visceral Empathy"). No niche-specific words in generic prompts: grep test for `somatic|documentary` outside DOCUMENTARY preset constants and tests.
P3.4 **Hygiene.** Delete `bun.lock` and the `.aistudio/` folder from the deliverable; `.gitignore` adds `.aistudio/`; ship `dist/` and `dist-server/` built fresh by `npm run build` (the Termux user needs no build step) while keeping them git-ignored; `start.sh` exports `SHOWRUNNER_MODE=termux` and `SHOWRUNNER_PORT`; `stop.sh` kills by pid file.
P3.5 **README rewrite**: Termux install steps; token location and where to paste it; adding a Gemini key + "Test key"; YouTube key optional; Master Prompt Override; Channel DNA paths; **Express Transcript Mode with accepted formats and examples of each (with sample 5-line snippets)**; precision grades explained; pacing table; API list; jobs; troubleshooting table mapping every typed error code to a fix; `npm run check/typecheck/test/build/smoke` descriptions.
P3.6 **Troubleshooting screen in app** ("Diagnostics"): shows runtime mode, port, token present, DB path/size, WAL ok, node version, keys status, models discovered per tier, last 20 redacted LLM log lines, last error per stage, one-tap "Copy diagnostics" (no secrets).
</part_P3_remaining_gaps>

<non_negotiable_rules>
1. No fabricated data, no hard-coded model names, no silent fallbacks – every failure is a typed error shown in the UI with retry/fix hint.
2. All timing math is deterministic integer-millisecond code; the LLM never computes time.
3. Every LLM response is schema-validated; invalid → bounded retry → typed error.
4. Secrets never logged, never returned unmasked, never written into the repo.
5. Estimated/interpolated data is always labelled as such everywhere it appears (UI, API, ZIP metadata).
6. Mobile first: 360 px, dark obsidian `#0B0D10`, touch targets ≥ 44 px, no horizontal scroll, Devanagari-capable fonts.
7. TypeScript strict; no `any` in new code; no `@ts-ignore`.
8. LLM and YouTube HTTP go through the single wrappers so tests inject fakes from `tests/fixtures/`.
</non_negotiable_rules>

<part_P4_testing_and_acceptance>
Extend `tests/` (node:test). All pass via `npm test`; also `npm run typecheck`, `npm run build`, `npm run check`.
E1  Timestamp: rollover cases from P1.5; ms integer math (no float drift) over a 3-hour synthetic stream; prompt-line regex test on S6 batches, packs, ZIP files, WS push payload; second-formatter grep test.
E2  Express parsing matrix: WebVTT (hours/no hours, ids, NOTE, settings, tags), SRT, WhisperX, Descript, flat JSON (sec and ms), ElevenLabs character alignment (Devanagari + Latin sample), CSV/TSV, `start end word` lines, `#[MM-SS.mmm] word` lines → expected word lists and exact ms.
E3  Precision grading: true-ms stream → WORD_EXACT_MS; 0.1 s-rounded → WORD_COARSE; sentence-level VTT → CUE_INTERPOLATED requires confirmation, words flagged `estimated`, interpolation weights by characters; export metadata carries grade.
E4  Validation errors with indices: too short, NaN, negative, non-monotonic, overlap, ambiguous units; gap warnings listed; non-speech tokens removed and restorable.
E5  Runtime lock = last word END; WPM math; no drift UI/rollback when no target; with target 660 s vs actual 710 s → drift flagged (existing behaviour kept).
E6  Express gates: project with no S1–S3 payloads proceeds S4→S5→S6→S7; missing key/models, missing DNA/Quick Style, or unlocked transcript each return the right typed gate error; replacing transcript marks S5–S7 DIRTY; "switch to full" marks S4+ DIRTY.
E7  Quick Style lock creates DNA `source:"EXPRESS"`; stages read it (assert fake-adapter prompt inputs contain niche/visual style; style prefix is DNA's, not the old documentary literal).
E8  Script alignment: pasted script aligned to transcript with confidence; low confidence ignored with notice; no script → Box 1 labelled reconstructed.
E9  S7 in Express: first-30 s EMRI from transcript; triples marked `USER_SCRIPT`/unverified; no "VERIFIED" badge; titles <60; overlap rule intact.
E10 Thumbnail vision: fake fetch + fake Gemini receives `inlineData`; failure → UNKNOWN/LOW; no invented traits.
E11 S5 job: 202 + job lifecycle + WS events; stale RUNNING jobs FAILED on boot.
E12 Naming migration: old `somaticHook15s` rows readable; no niche-specific words outside DOCUMENTARY preset (grep test).
E13 Security regression: 401 without token on every `/api/v1/*` (except runtime), 403 bad Origin, WS token required, masking, secret scan clean.
E14 E2E smoke (`npm run smoke`, fake adapters): (a) Express path: paste true-ms VTT-like JSON → Quick Style → slice (Omni 6 s) → prompts (regex check) → packaging → ZIP; (b) Full path with DNA Path B; (c) Express with CUE_INTERPOLATED transcript flagged end-to-end.
Definition of Done – PRINT REAL OUTPUTS in your final answer: `npm run typecheck` (clean); `npm test` (pass counts); `npm run build` (ok); `npm run check` (secret scan clean); `NODE_ENV=production SHOWRUNNER_MODE=termux node dist-server/server.mjs` boots and logs the listening line; `curl -i http://127.0.0.1:5000/api/v1/pipeline/state` → 401 without token and 200 with token; `curl` of `/api/v1/health/llm`; and these greps return nothing outside constants/tests: `proj-alpha-01`, hard-coded Gemini model ids, `text-embedding-004`, `LATIN_PHONETIC_MAP`, `FALLBACK_OVERLAY_BANK`, `synthesizeWordTimingsFromScript`, `cinematic documentary frame`, `Documentary Niche`, `AIza`, `AQ\.`.
</part_P4_testing_and_acceptance>

<execution_protocol>
M1 P1 timestamps + prompt syntax + DNA style prefix + tests E1, E12 (part) → `npm run typecheck && npm test`.
M2 P2 parsing/validation/precision grading/runtime lock (E2–E5).
M3 P2 gates, Express state, Quick Style, script alignment, S7 Express behaviour (E6–E9).
M4 P2 UI (wizard card, import screen, previews, chips, banners) + P3.6 Diagnostics screen.
M5 P3 gaps: thumbnail vision, S5 job, naming, hygiene, README (E10–E12).
M6 Security regression, E2E smoke, full Definition of Done run with printed outputs (E13, E14).
After each milestone run typecheck + tests and fix before moving on. At the end print a table: item (P1.1…P3.6) → files changed → test name → PASS. If anything cannot be completed, state exactly what and why; never claim completion falsely.
</execution_protocol>

<final_instruction>
Deliver the complete updated project (all files, not diffs). Every item in P1, P2 and P3 must be implemented and tested in this pass, with real command outputs for the Definition of Done.
</final_instruction>

anything cannot be completed, state exactly what and why; never claim completion falsely.
</execution_protocol>

<final_instruction>
Deliver the complete updated project (all files, not diffs). Every item in P1, P2 and P3 must be implemented and tested in this pass, with real command outputs for the Definition of Done.
</final_instruction>

## PROMPT END
