// Bundles the chair's recorded reasoning texts for the page: `{schema, texts: {<sha256 hex>: {text, chair, kind, source}}}`.
// The sources are the run records in the repo's docs/ folder: `testnet-run-agent-*decisions.jsonl` (the text as JSON, exact)
// and `testnet-run-agent-*.txt` (the same text, each line prefixed by "  | "). A text is bundled only if its SHA-256 equals the
// hash the record claims, so the bundle never holds a text the chain could not confirm. A missing folder or file, an
// unreadable line, or a record that does not hash to its own hash is skipped and named in `warnings`; none stops the build.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA = "chair-minutes/1";
const HASH_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^testnet-run-agent-[\w.-]*(decisions\.jsonl|\.txt)$/;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function fromJsonl(raw, file, add) {
  raw.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return add.warn(`${file}:${i + 1}: not JSON, skipped`);
    }
    if (r?.kind !== "decision") return;
    add.text(r.reasoning_hash, r.reasoning, r.chair, r.chair_kind, `${file}:${i + 1}`, file);
  });
}

// One block per decision: `epoch N | chair LABEL (KIND) | rate A -> B bps`, `reasoning_hash: H`, a `--- reasoning` line, then the text lines.
function fromTxt(raw, file, add) {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^epoch \d+ \| chair (.+) \((\w+)\) \| rate /.exec(lines[i]);
    if (!head) continue;
    const hash = /^reasoning_hash: (\S+)$/.exec(lines[i + 1] ?? "")?.[1];
    if (hash === undefined || !(lines[i + 2] ?? "").startsWith("--- reasoning")) {
      add.warn(`${file}:${i + 1}: decision block without a reasoning_hash and reasoning header, skipped`);
      continue;
    }
    const body = [];
    for (let j = i + 3; j < lines.length && /^  \|( |$)/.test(lines[j]); j++) body.push(lines[j].slice(4));
    add.text(hash, body.join("\n"), head[1], head[2], `${file}:${i + 1}`, file);
  }
}

export async function bundleMinutes(docsDir) {
  const texts = {};
  const warnings = [];
  const add = {
    warn: (w) => warnings.push(w),
    text(hash, text, chair, kind, where, source) {
      if (typeof hash !== "string" || !HASH_RE.test(hash) || typeof text !== "string" || text === "") return warnings.push(`${where}: no usable reasoning or hash, skipped`);
      if (sha256(text) !== hash) return warnings.push(`${where}: the text does not hash to its reasoning_hash, skipped`);
      texts[hash] ??= { text, chair: typeof chair === "string" ? chair : null, kind: typeof kind === "string" ? kind : null, source };
    },
  };
  let names;
  try {
    names = (await readdir(docsDir)).filter((f) => FILE_RE.test(f));
  } catch {
    return { bundle: { schema: SCHEMA, texts }, warnings: [`${docsDir}: not readable, no reasoning texts bundled`] };
  }
  // JSONL first: it carries the text exactly; a .txt only adds hashes the JSONL files do not have.
  names.sort((a, b) => Number(b.endsWith(".jsonl")) - Number(a.endsWith(".jsonl")) || a.localeCompare(b));
  for (const file of names) {
    let raw;
    try {
      raw = await readFile(join(docsDir, file), "utf8");
    } catch (e) {
      warnings.push(`${file}: ${e.code ?? "unreadable"}, skipped`);
      continue;
    }
    (file.endsWith(".jsonl") ? fromJsonl : fromTxt)(raw, file, add);
  }
  const sorted = Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a.localeCompare(b)));
  return { bundle: { schema: SCHEMA, texts: sorted }, warnings };
}
