import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULES, loadContext, runChecks } from "../check-deploy.mjs";

function runC5(root) {
  const rule = RULES.find((r) => r.id === "C5");
  const ctx = loadContext(root);
  return rule.check(ctx);
}

test("C5 FAIL: compose uses DB_POOL_SIZE but config.js reads DB_POOL_MAX", () => {
  const dir = mkdtempSync(join(tmpdir(), "c5-fail-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "pipeline"));
    mkdirSync(join(dir, "app", "src"), { recursive: true });
    writeFileSync(
      join(dir, "app", "src", "config.js"),
      `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsToken: env.SMS_TOKEN || "",
  };
}\n`,
    );
    writeFileSync(
      join(dir, "deploy", "compose.yaml"),
      [
        "services:",
        "  api:",
        "    image: poshtomat:1.8.0",
        "    environment:",
        "      PORT: '8080'",
        "      DB_POOL_SIZE: '20'",
        "      DB_POOL_WAIT_MS: '2000'",
        "      SMS_TOKEN: ${SMS_TOKEN:?}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM node:22\n");
    const result = runC5(dir);
    assert.equal(result.status, "FAIL");
    assert.match(result.message, /DB_POOL_MAX/);
    assert.match(result.message, /DB_POOL_SIZE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C5 PASS: compose uses the correct variable names from config.js", () => {
  const dir = mkdtempSync(join(tmpdir(), "c5-pass-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "pipeline"));
    mkdirSync(join(dir, "app", "src"), { recursive: true });
    writeFileSync(
      join(dir, "app", "src", "config.js"),
      `export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    dbPoolMax: Number(env.DB_POOL_MAX) || 4,
    dbPoolWaitMs: Number(env.DB_POOL_WAIT_MS) || 2000,
    smsToken: env.SMS_TOKEN || "",
  };
}\n`,
    );
    writeFileSync(
      join(dir, "deploy", "compose.yaml"),
      [
        "services:",
        "  api:",
        "    image: poshtomat:1.8.0",
        "    environment:",
        "      PORT: '8080'",
        "      DB_POOL_MAX: '20'",
        "      DB_POOL_WAIT_MS: '2000'",
        "      SMS_TOKEN: ${SMS_TOKEN:?}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM node:22\n");
    const result = runC5(dir);
    assert.equal(result.status, "PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
