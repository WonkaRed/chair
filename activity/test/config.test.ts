import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";

const env = {
  CHAIR_ACTIVITY_KEY_DIR: "/keys",
  CHAIR_TOKEN: "token.c.testnet",
  CHAIR_ACTIVITY_HOLDERS: "a.c.testnet, b.c.testnet,c.c.testnet",
  XDG_STATE_HOME: "/state",
};

test("a full environment parses; the log goes under the state directory by default", () => {
  const c = parseConfig(env, ["--epochs", "3"]);
  assert.deepEqual(c.holders, ["a.c.testnet", "b.c.testnet", "c.c.testnet"]);
  assert.equal(c.keyDir, "/keys");
  assert.equal(c.logPath, "/state/chair-activity/activity.jsonl");
  assert.equal(c.maxEpochs, 3);
  assert.equal(parseConfig(env, []).maxEpochs, null);
});

test("there is no default key directory", () => {
  assert.throws(() => parseConfig({ ...env, CHAIR_ACTIVITY_KEY_DIR: undefined }, []), /set CHAIR_ACTIVITY_KEY_DIR/);
  assert.throws(() => parseConfig({ ...env, CHAIR_ACTIVITY_KEY_DIR: "" }, []), /set CHAIR_ACTIVITY_KEY_DIR/);
});

test("only testnet accounts, exactly three different holders, and a sane epoch count are accepted", () => {
  assert.throws(() => parseConfig({ ...env, CHAIR_TOKEN: "token.near" }, []), /testnet only/);
  assert.throws(() => parseConfig({ ...env, CHAIR_ACTIVITY_HOLDERS: "a.c.testnet,b.c.near,c.c.testnet" }, []), /testnet only/);
  assert.throws(() => parseConfig({ ...env, CHAIR_ACTIVITY_HOLDERS: "a.c.testnet,b.c.testnet" }, []), /three different/);
  assert.throws(() => parseConfig({ ...env, CHAIR_ACTIVITY_HOLDERS: "a.c.testnet,a.c.testnet,b.c.testnet" }, []), /three different/);
  for (const bad of [["--epochs"], ["--epochs", "0"], ["--epochs", "x"], ["--epochs", "2", "3"], ["3"]]) assert.throws(() => parseConfig(env, bad), /usage/);
});

test("CHAIR_ACTIVITY_EVERY defaults to 1, takes a whole number from 1 up, and anything else is refused at start", () => {
  assert.equal(parseConfig(env, []).every, 1);
  assert.equal(parseConfig({ ...env, CHAIR_ACTIVITY_EVERY: "6" }, []).every, 6);
  for (const bad of ["0", "-1", "1.5", "six", "", " 6", "06", "1e3"]) {
    assert.throws(() => parseConfig({ ...env, CHAIR_ACTIVITY_EVERY: bad }, []), /CHAIR_ACTIVITY_EVERY must be a whole number of epochs, at least 1/, `"${bad}"`);
  }
});
