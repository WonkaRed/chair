import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DISCLOSURE, FileLog, near, tokens } from "../src/log.ts";
import { TOKEN } from "../src/plan.ts";

const scratch = join(homedir(), ".scratch", "tmp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "chair-activity-log."));
after(() => rmSync(root, { recursive: true, force: true }));

test("every record is a JSON line and a stdout line that both say it is scripted test activity", () => {
  const path = join(root, "state", "activity.jsonl");
  const lines: string[] = [];
  const log = new FileLog(path, (l) => lines.push(l), () => new Date("2026-11-11T10:00:00Z"));
  log.write({ event: "action", hash: "H1", amount: 5n * TOKEN }, "alice stakes 5.00 $CHAIR: success, tx H1");
  log.write({ event: "stopped" }, "stopped");
  const records = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { at: "2026-11-11T10:00:00.000Z", disclosure: DISCLOSURE, event: "action", hash: "H1", amount: (5n * TOKEN).toString() });
  assert.equal(records[1]?.["disclosure"], DISCLOSURE);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.includes("scripted test activity by three accounts we control, not organic users"));
});

test("amounts print as plain decimals", () => {
  assert.equal(tokens(12_345n * TOKEN + TOKEN / 4n), "12345.25");
  assert.equal(near(496_574_818_860_630_799_999_998n), "0.49657");
  assert.equal(near(5n * 10n ** 22n), "0.05000");
});
