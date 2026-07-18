---
description: Synthesize my reply voice from my own past replies (data/my-replies.json) into config/voice.proposed.md + a calibration report. Never overwrites voice.md — shows a diff for my approval.
allowed-tools: Read, Write, Bash
---

You are calibrating my reply voice from my **real** past replies. This learns how I actually
sound instead of describing it by hand (§12).

## Hard rules (non-negotiable)

- **READ-ONLY against X.** Do not fetch anything. `npm run calibrate:fetch` (a separate,
  deterministic step) already wrote `data/my-replies.json`. You only read local files and write
  proposals — never touch X, never run `bird`.
- **NEVER overwrite `config/voice.md`.** You write `config/voice.proposed.md` and
  `config/voice-calibration-report.md` only, then show me a diff. I decide.
- **Use only real replies as evidence.** Every example you cite must be a verbatim reply from
  `data/my-replies.json`. Do not invent replies, engagement numbers, or dates.

## Steps

1. **Read `data/my-replies.json`.** It has my authored replies bucketed by age:
   - **Bucket A (0–4 wks) — calibrate.** Freshest = who I am now. Extract the tone from here.
   - **Bucket B (4–12 wks) — validate.** Check the traits hold. If B disagrees with A, **A wins**
     (more recent), but note the shift in the report.
   - **Bucket C (12–26 wks) — held-out test.** Drift check. Often partial or empty — that's
     expected, not a failure.
   Also read the `range_fetched`, `counts`, `partial`, and `notes` fields, and read the current
   `config/voice.md` (Appendix A structure) so your proposal stays in the same shape.
   If bucket A is empty, say so plainly in the report and do not fabricate a voice — stop.
3. **Extract tone traits from Bucket A** (§12.4), each backed by 2–3 real example replies:
   - length + range (let the short ones — "lol", "this 👏" — set the floor);
   - formality/warmth markers; how I open and close;
   - emoji / hashtag / punctuation habits as an **observed rate**, not a guess;
   - the ratio of moves (ask vs assert vs agree vs push back) and *what kind of tweet* triggers
     each; recurring phrasing tics; anti-tells (things I never do).
   **Engagement-weight the exemplars**: favour replies that landed (higher `signal`) when picking
   the best representatives, but keep some low-signal ones to show range.
4. **Validate against Bucket B**; note confirmation or drift. **Check Bucket C** if non-empty.
5. **Write `config/voice.proposed.md`** — same structure as `config/voice.md`/Appendix A, filled
   from the extracted traits, with **3–5 example replies pulled verbatim from my highest-signal
   real replies** (include the parent tweet as context where `in_reply_to.text` is present).
   Preserve my hand-written "Never do" / "AI tells" intent unless the data clearly contradicts it
   — and if it does, flag that in the report rather than silently dropping my rule.
6. **Write `config/voice-calibration-report.md`** (§12.5): the real date range fetched and reply
   counts per bucket; each trait with 2–3 real example replies as evidence; drift notes (A vs B
   vs C); and anything low-confidence because a bucket was thin or `partial` was true.
7. **Show me a diff** between `config/voice.md` and `config/voice.proposed.md`
   (`diff -u config/voice.md config/voice.proposed.md` via Bash, or summarize the changes
   clearly). Then stop and ask for approval. **Do not modify `config/voice.md`.**

## Output discipline

Both output files are git-ignored. Keep the proposal genuinely usable as a drop-in replacement
if I approve it — same headings, my voice, real examples. The report is where the transparency
lives: show your evidence so I can trust (or reject) the proposal.
