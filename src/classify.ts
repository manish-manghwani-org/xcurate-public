import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Settings } from "./config.js";
import {
  CLASSIFICATIONS_PATH,
  UNCLASSIFIED_PATH,
  exportUnclassified,
  loadBuckets,
} from "./buckets.js";
import { UnclassifiedFile, type BucketsConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Local classifier (PLANNING.md §2.7) — replaces the agent for backfill topic
// bucketing. Slots between `buckets export` and `buckets apply`: reads
// data/unclassified.json, asks a local Ollama model for one bucket per tweet
// (output constrained to the bucket-name enum so it *cannot* be invalid),
// writes data/classifications.json. Fully local — only tweet text leaves this
// process, and only to 127.0.0.1. Never touches X or the cookie.
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  limit?: number; // override settings.buckets.exportLimit for the export batch
  model?: string; // override settings.classify.model (A/B without editing config)
  dryRun?: boolean; // print the label distribution, do not write classifications.json
  reuseExport?: boolean; // classify the existing unclassified.json (skip re-export)
  onProgress?: (done: number, total: number) => void;
}

export interface ClassifyResult {
  path: string | null; // null on dry-run
  model: string;
  total: number;
  fallbacks: number; // tweets that fell to `other` after exhausting retries
  prefiltered: number; // tweets labeled `other` by the S3 heuristic (no model call)
  remaining: number; // still-unlabeled tweets beyond this batch (from the export)
  distribution: Array<{ bucket: string; count: number }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The classification rubric — mirrors .claude/commands/classify-tweets.md, built
 *  from config/buckets.json so the definitions stay a single source of truth. */
function buildSystemPrompt(config: BucketsConfig): string {
  const list = config.buckets.map((b) => `- ${b.name}: ${b.definition}`).join("\n");
  return `You classify a single tweet into exactly one topic bucket.

Rules:
- Judge the tweet's TOPIC. Work and building (code, AI/ML, startups, product, markets, jobs) is professional — even a joke about it, unless the topic is only a prop for the joke.
- Classify promotional or self-marketing tweets by their surface TOPIC too (a launch of an AI tool is professional; a "follow me" over a movie clip is personal-social). There is no promo bucket.
- Public affairs (elections, policy, activism, causes, breaking news) is civic.
- Everyday human and cultural life is personal-social: the author's own daily life, family, food, outings and milestones; health and fitness; memes and jokes; movies, music, books, sports and pop culture.
- Research, science, psychology, history, and philosophy, faith or mindset reflection are ideas.
- When genuinely torn or the tweet is too thin to tell — a bare @-reply, a greeting, a topicless fragment — use other. Never force-fit.

Buckets:
${list}

Respond with a JSON object of the form {"bucket": "<one bucket name>"} and nothing else.`;
}

// S3 pre-filter (PLANNING.md §2.7.1): pure greetings/acknowledgements that, on
// their own, carry no topic — a bare "gm" tweet is `other`.
const GREETING_ACK = new Set([
  "gm", "gn", "good morning", "good night", "good evening", "goodmorning", "morning",
  "thanks", "thank you", "ty", "tysm", "congrats", "congratulations", "welcome", "noted",
  "lol", "lmao", "lmfao", "haha", "hahaha", "hehe", "ok", "okay", "yes", "yeah", "yep", "yup",
  "no", "nope", "same", "nice", "cool", "done", "agreed", "true", "facts", "hi", "hey",
  "hello", "sure", "great", "wow", "omg", "rip",
]);

/**
 * S3 pre-filter (PLANNING.md §2.7.1): cheaply label the tweets that are obviously
 * `other` — bare @-replies, greetings, and topicless fragments — so the local model
 * never has to see them. Deliberately CONSERVATIVE: it fires only when there is
 * essentially no topical content left, so it never steals a real topic label. Only
 * @-led replies get the short-fragment treatment; a short standalone tweet
 * ("Argentina won") still goes to the model.
 */
export function isObviousOther(text: string): boolean {
  const residue = text
    .replace(/https?:\/\/\S+/gi, " ") // links
    .replace(/[@#]\w+/g, " ") // @mentions / #hashtags
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // emoji & punctuation
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (residue === "") return true; // only mentions / links / emoji
  if (GREETING_ACK.has(residue)) return true; // pure greeting or acknowledgement

  // an @-led reply whose remaining content is ≤3 words is a thin conversational fragment
  const isReply = /^\s*@\w+/.test(text);
  if (isReply && residue.split(" ").length <= 3) return true;

  return false;
}

/** Confirm Ollama is up and the model is present, with actionable errors. */
export async function ensureModel(endpoint: string, model: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${endpoint}/api/tags`);
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama at ${endpoint} — is it running? Start it with \`ollama serve\`. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) throw new Error(`Ollama at ${endpoint} returned ${res.status} for /api/tags.`);
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  const names = (data.models ?? []).map((m) => m.name ?? "");
  const present = names.some((n) => n === model || n.split(":")[0] === model.split(":")[0]);
  if (!present) {
    throw new Error(
      `Model "${model}" is not pulled in Ollama. Run \`ollama pull ${model}\` first. ` +
        `Installed: ${names.join(", ") || "(none)"}.`,
    );
  }
}

/** Classify one tweet. Returns a valid bucket name, or null after all retries fail. */
async function classifyOne(
  endpoint: string,
  model: string,
  system: string,
  text: string,
  bucketNames: string[],
  timeoutMs: number,
  maxRetries: number,
  backoffBaseSeconds: number,
): Promise<string | null> {
  const body = {
    model,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    // Structured output: the model is forced to emit one of the valid names.
    format: {
      type: "object",
      properties: { bucket: { type: "string", enum: bucketNames } },
      required: ["bucket"],
      additionalProperties: false,
    },
    options: { temperature: 0 },
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Ollama /api/chat returned ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      const content = data.message?.content ?? "";
      const parsed = JSON.parse(content) as { bucket?: string };
      if (parsed.bucket && bucketNames.includes(parsed.bucket)) return parsed.bucket;
      throw new Error(`unexpected model output: ${content.slice(0, 120)}`);
    } catch {
      if (attempt === maxRetries) return null;
      await sleep(backoffBaseSeconds * 1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Classify a list of tweets with a bounded worker pool (concurrency 1 = serial,
 * best for CPU-bound local inference). Pure: does no export, no DB, no preflight
 * — the caller owns those. `labels[i]` aligns with `items[i]`; a tweet that
 * exhausts its retries is labeled `other` and counted in `fallbacks`. Shared by
 * both the backfill classifier and the eval harness.
 */
export async function classifyTweets(
  settings: Settings,
  model: string,
  config: BucketsConfig,
  items: Array<{ id: string; text: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ labels: string[]; fallbacks: number; prefiltered: number }> {
  const cfg = settings.classify;
  const bucketNames = config.buckets.map((b) => b.name);
  const system = buildSystemPrompt(config);
  const labels = new Array<string>(items.length);
  let fallbacks = 0;
  let prefiltered = 0;
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      // S3: skip the model entirely for obvious `other` (thin @-replies, greetings).
      if (isObviousOther(item.text)) {
        labels[i] = "other";
        prefiltered += 1;
        done += 1;
        onProgress?.(done, items.length);
        continue;
      }
      const bucket = await classifyOne(
        cfg.endpoint,
        model,
        system,
        item.text,
        bucketNames,
        cfg.timeoutMs,
        cfg.maxRetries,
        settings.ingest.backoffBaseSeconds,
      );
      if (bucket === null) {
        fallbacks += 1;
        labels[i] = "other"; // fail-safe: never crash the batch, never leave a hole
      } else {
        labels[i] = bucket;
      }
      done += 1;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(cfg.concurrency, items.length || 1)) }, worker),
  );
  return { labels, fallbacks, prefiltered };
}

/** Run the local classifier over the current unclassified batch. */
export async function runClassify(
  settings: Settings,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const cfg = settings.classify;
  const model = opts.model ?? cfg.model;

  // 1. Refresh the batch (unless reusing an existing export, e.g. for re-runs/eval).
  if (!opts.reuseExport) {
    exportUnclassified(opts.limit ?? settings.buckets.exportLimit);
  }

  // 2. Read the batch the pipeline produced.
  let file;
  try {
    file = UnclassifiedFile.parse(JSON.parse(readFileSync(UNCLASSIFIED_PATH, "utf8")));
  } catch (err) {
    throw new Error(
      `Could not read ${UNCLASSIFIED_PATH} — run \`npm run buckets:export\` first: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const config = loadBuckets();
  const tweets = file.tweets;

  // 3. Preflight — fail fast (and leave the DB untouched) if the model is unavailable.
  await ensureModel(cfg.endpoint, model);

  // 4. Classify.
  const { labels, fallbacks, prefiltered } = await classifyTweets(
    settings,
    model,
    config,
    tweets,
    opts.onProgress,
  );

  // 5. Tally the distribution (descending).
  const counts = new Map<string, number>();
  for (const b of labels) counts.set(b, (counts.get(b) ?? 0) + 1);
  const distribution = [...counts.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count);

  // 6. Write classifications.json (in the exact shape `buckets apply` consumes).
  let outPath: string | null = null;
  if (!opts.dryRun) {
    const out = {
      classified_at: new Date().toISOString(),
      classifications: tweets.map((t, i) => ({ id: t.id, bucket: labels[i] ?? "other" })),
    };
    mkdirSync(path.dirname(CLASSIFICATIONS_PATH), { recursive: true });
    writeFileSync(CLASSIFICATIONS_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
    outPath = CLASSIFICATIONS_PATH;
  }

  return {
    path: outPath,
    model,
    total: tweets.length,
    fallbacks,
    prefiltered,
    remaining: file.remaining,
    distribution,
  };
}
