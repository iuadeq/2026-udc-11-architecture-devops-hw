// Tests for tools/check-deploy.mjs. Each rule gets small, generic snippets — one
// that passes and the ways it can fail. Most tests hand the rules already-parsed
// objects; the last ones go through loadContext, the real CLI and the YAML parser.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyYamlFailure,
  dockerfileSource,
  formatReport,
  isSecretLike,
  isSecretReference,
  loadContext,
  parseYaml,
  RULES,
  runChecks,
} from "../check-deploy.mjs";

const CHECKER = fileURLToPath(new URL("../check-deploy.mjs", import.meta.url));

function ctx({ dockerfile = null, compose, workflow } = {}) {
  return {
    root: ".",
    dockerfile: dockerfileSource(dockerfile),
    compose: compose === undefined ? { exists: false } : { exists: true, data: compose },
    workflow: workflow === undefined ? { exists: false } : { exists: true, data: workflow },
  };
}

function status(id, context) {
  const rule = RULES.find((r) => r.id === id);
  return rule.check(context).status;
}

const svc = (extra = {}) => ({ image: "example/web:1.4.2", ...extra });
const compose = (...list) => ({ services: Object.fromEntries(list.map((s, i) => [`s${i + 1}`, s])) });
const wf = (extra = {}) => ({ on: { push: { branches: ["main"] } }, permissions: { contents: "read" }, jobs: {}, ...extra });

test("D1: the base image needs an explicit tag that is not latest", () => {
  assert.equal(status("D1", ctx({ dockerfile: "FROM node:22-alpine\n" })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: "FROM node\n" })), "FAIL");
  assert.equal(status("D1", ctx({ dockerfile: "FROM node:latest\n" })), "FAIL");
  assert.equal(status("D1", ctx({ dockerfile: "FROM node:22 AS build\nRUN true\nFROM build\n" })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: `FROM --platform=linux/amd64 node@sha256:${"a".repeat(64)}\n` })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: "ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-slim\n" })), "PASS");
  assert.equal(status("D1", ctx({ dockerfile: "ARG NODE_VERSION\nFROM node:${NODE_VERSION}\n" })), "FAIL");
  assert.equal(status("D1", ctx({ dockerfile: "FROM example.org:5000/base\n" })), "FAIL"); // a port is not a tag
  assert.equal(status("D1", ctx({})), "FAIL");
});

test("D2: the final stage runs as a non-root USER", () => {
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER node\nCMD [\"node\"]\n" })), "PASS");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER 1000:1000\n" })), "PASS");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\n" })), "FAIL");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER root\n" })), "FAIL");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22\nUSER 0:0\n" })), "FAIL");
  assert.equal(status("D2", ctx({ dockerfile: "FROM node:22 AS b\nUSER node\nFROM node:22\n" })), "FAIL");
});

test("D3: a HEALTHCHECK in the Dockerfile or a healthcheck on every compose service", () => {
  const hc = { test: ["CMD", "true"], interval: "30s" };
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\nHEALTHCHECK --interval=30s CMD true\n" })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ healthcheck: hc })) })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc()) })), "FAIL");
  // a one-shot job (no ports, restart: "no") needs no healthcheck; a long-running service still does
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ restart: "no" })) })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ restart: "no", ports: ["80:80"] })) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: { ...hc, disable: true } })) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\nHEALTHCHECK NONE\n", compose: compose(svc()) })), "FAIL");
  // test NONE switches the check off just like disable: true
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: hc }), svc({ healthcheck: { test: ["NONE"] } })) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: "FROM a:1\n", compose: compose(svc({ healthcheck: { test: "NONE" } })) })), "FAIL");
  // with a HEALTHCHECK in the image: a service without ports may switch it off, one with ports may not
  const image = "FROM a:1\nHEALTHCHECK CMD node -e \"process.exit(0)\"\n";
  const api = (healthcheck) => svc({ ports: ["8080:8080"], ...(healthcheck ? { healthcheck } : {}) });
  assert.equal(status("D3", ctx({ dockerfile: image, compose: compose(api(), svc({ healthcheck: { disable: true } })) })), "PASS");
  assert.equal(status("D3", ctx({ dockerfile: image, compose: compose(api({ disable: true }), svc()) })), "FAIL");
  assert.equal(status("D3", ctx({ dockerfile: image, compose: compose(api({ test: ["NONE"] })) })), "FAIL");
});

test("D4: no secret-like ENV or ARG with a value baked into the image", () => {
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV NODE_ENV=production PORT=8080\nARG NPM_TOKEN\n" })), "PASS");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV DB_PASSWORD_FILE=/run/secrets/db\n" })), "PASS");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV API_TOKEN=CHANGE_ME\n" })), "FAIL");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV NODE_ENV=production \\\n    SIGNING_KEY=CHANGE_ME\n" })), "FAIL");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV API_KEY CHANGE_ME\n" })), "FAIL"); // legacy form
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nARG DB_PASSWORD=CHANGE_ME\n" })), "FAIL");
  assert.equal(status("D4", ctx({ dockerfile: "FROM a:1\nENV PGPASSWORD=CHANGE_ME\n" })), "FAIL"); // no underscore before PASSWORD
});

test("C1: compose images are pinned", () => {
  assert.equal(status("C1", ctx({ compose: compose(svc(), svc({ image: "registry.example.org/web:${IMAGE_TAG:?set it}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: `web@sha256:${"b".repeat(64)}` })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:latest" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose({ build: "." }) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:${TAG:-latest}" })) })), "FAIL");
  assert.equal(status("C1", ctx({})), "FAIL");
  // variables: the :- default is what runs when the variable is not set; :? makes it required
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:${TAG:-1.4.2}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "${IMAGE:-web:1.4.2}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "${IMAGE:?set IMAGE}" })) })), "PASS");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "${IMAGE:-poshtomat}" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "web:${TAG}" })) })), "FAIL");
  assert.equal(status("C1", ctx({ compose: compose(svc({ image: "$IMAGE" })) })), "FAIL");
});

test("C2: every service has a restart policy", () => {
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "unless-stopped" }), svc({ restart: "on-failure:3" })) })), "PASS");
  assert.equal(status("C2", ctx({ compose: compose(svc({ deploy: { restart_policy: { condition: "on-failure" } } })) })), "PASS");
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "always" }), svc()) })), "FAIL");
  // a one-shot job without ports may say restart: "no"; a service with ports may not
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "no" })) })), "PASS");
  assert.equal(status("C2", ctx({ compose: compose(svc({ restart: "no", ports: ["8080:8080"] })) })), "FAIL");
  assert.equal(status("C2", ctx({ compose: compose(svc({ deploy: { restart_policy: { condition: "none" } } })) })), "PASS");
});

test("C3: every service has a memory limit", () => {
  assert.equal(status("C3", ctx({ compose: compose(svc({ mem_limit: "256m" }), svc({ deploy: { resources: { limits: { memory: "128M" } } } })) })), "PASS");
  assert.equal(status("C3", ctx({ compose: compose(svc({ mem_limit: "256m" }), svc()) })), "FAIL");
  assert.equal(status("C3", ctx({ compose: compose(svc({ deploy: { resources: { limits: { cpus: "0.5" } } } })) })), "FAIL");
});

test("C4: secret-like compose variables come only by reference", () => {
  const ok = svc({ environment: { API_TOKEN: "${API_TOKEN}", DB_PASSWORD: "${DB_PASSWORD:?missing}", LOG_LEVEL: "info" } });
  assert.equal(status("C4", ctx({ compose: compose(ok) })), "PASS");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: ["API_TOKEN", "LOG_LEVEL=info"] })) })), "PASS");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: { API_TOKEN: "CHANGE_ME" } })) })), "FAIL");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: ["API_TOKEN=CHANGE_ME"] })) })), "FAIL");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: { API_TOKEN: "${API_TOKEN:-CHANGE_ME}" } })) })), "FAIL");
  assert.equal(status("C4", ctx({ compose: compose(svc({ environment: { PGPASSWORD: "CHANGE_ME" } })) })), "FAIL");
});

test("W1: the workflow exists, parses, and does not use pull_request_target", () => {
  assert.equal(status("W1", ctx({ workflow: wf() })), "PASS");
  assert.equal(status("W1", ctx({})), "FAIL");
  assert.equal(status("W1", { ...ctx(), workflow: { exists: true, error: "YAMLParseError: bad indent" } }), "FAIL");
  assert.equal(status("W1", ctx({ workflow: { on: "push" } })), "FAIL"); // no jobs
  assert.equal(status("W1", ctx({ workflow: wf({ on: "pull_request_target" }) })), "FAIL");
  assert.equal(status("W1", ctx({ workflow: wf({ on: ["push", "pull_request_target"] }) })), "FAIL");
  assert.equal(status("W1", ctx({ workflow: wf({ on: { pull_request_target: { types: ["opened"] } } }) })), "FAIL");
});

test("W2–W5 are skipped, not failed, while there is no workflow", () => {
  const results = runChecks(ctx({}));
  assert.deepEqual(
    results.filter((r) => r.id.startsWith("W")).map((r) => [r.id, r.status]),
    [["W1", "FAIL"], ["W2", "SKIP"], ["W3", "SKIP"], ["W4", "SKIP"], ["W5", "SKIP"]],
  );
});

test("W2: top-level permissions are set and not write-all", () => {
  assert.equal(status("W2", ctx({ workflow: wf() })), "PASS");
  assert.equal(status("W2", ctx({ workflow: wf({ permissions: "read-all" }) })), "PASS");
  const { permissions, ...noPermissions } = wf();
  assert.equal(status("W2", ctx({ workflow: noPermissions })), "FAIL");
  assert.equal(status("W2", ctx({ workflow: wf({ permissions: "write-all" }) })), "FAIL");
});

test("W3: the deploy job has an environment and needs the tests, directly or through other jobs", () => {
  const unit = { "runs-on": "ubuntu-latest", steps: [{ run: "npm test" }] };
  const ship = (needs) => ({ "runs-on": "ubuntu-latest", environment: "production", needs, steps: [{ run: "./ship.sh" }] });
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: unit, deploy: ship("test") } }) })), "PASS");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { checks: unit, build: { needs: ["checks"] }, release: ship(["build"]) } }) })), "PASS");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: unit, deploy: ship(undefined) } }) })), "FAIL");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { lint: { steps: [{ run: "echo ok" }] }, deploy: ship("lint") } }) })), "FAIL");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: unit, deploy: { needs: "test" } } }) })), "FAIL");
  // a job called test that runs no tests is not a test job; a reusable workflow is judged by its id or path
  const fake = { "runs-on": "ubuntu-latest", steps: [{ run: "echo skipped" }, { run: "echo ok" }] };
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: fake, deploy: ship("test") } }) })), "FAIL");
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: { uses: "./.github/workflows/ci.yml" }, deploy: ship("test") } }) })), "PASS");
  // tests run inside a Dockerfile test stage count as tests
  const staged = { "runs-on": "ubuntu-latest", steps: [{ run: "docker build --target test --file deploy/Dockerfile app" }] };
  assert.equal(status("W3", ctx({ workflow: wf({ jobs: { test: staged, deploy: ship("test") } }) })), "PASS");
});

test("W4: secret-like values in the workflow come only from secrets", () => {
  const job = (extra) => ({ jobs: { deploy: { "runs-on": "ubuntu-latest", ...extra } } });
  const good = job({
    permissions: { "id-token": "write", contents: "read" },
    env: { API_TOKEN: "${{ secrets.API_TOKEN }}", GH_TOKEN: "${{ github.token }}" },
    steps: [
      { uses: "actions/cache@v4", with: { key: "npm-${{ hashFiles('**/package.json') }}", "restore-keys": "npm-" } },
      { uses: "docker/login-action@v3", with: { password: "${{ secrets.REGISTRY_PASSWORD || github.token }}" } },
      { uses: "docker/build-push-action@v6", with: { secrets: "npm_token=${{ secrets.NPM_TOKEN }}\n" } },
      { run: 'API_TOKEN="$API_TOKEN" ./ship.sh' },
      {
        uses: "appleboy/ssh-action@v1.2.0",
        with: { key: "${{ secrets.DEPLOY_SSH_KEY }}", script: 'cd /opt/app\nAPI_TOKEN="$API_TOKEN" docker compose up -d\n' },
      },
    ],
  });
  assert.equal(status("W4", ctx({ workflow: wf(good) })), "PASS");
  const reusable = { jobs: { ship: { uses: "example/workflows/.github/workflows/ship.yml@v2", secrets: "inherit" } } };
  assert.equal(status("W4", ctx({ workflow: wf(reusable) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: wf({ env: { API_TOKEN: "CHANGE_ME" } }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ uses: "x/y@v1", with: { password: "CHANGE_ME" } }] })) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ run: "API_TOKEN=CHANGE_ME ./ship.sh" }] })) })), "FAIL");
  const step = (s) => wf(job({ steps: [s] }));
  // ssh deploy actions: the private key and the remote script
  const ssh = (w) => step({ uses: "appleboy/ssh-action@v1.2.0", with: { host: "203.0.113.5", ...w } });
  assert.equal(status("W4", ctx({ workflow: ssh({ key: "CHANGE_ME" }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: ssh({ key: "CHANGE_ME-literal-ssh-key" }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: ssh({ script: "SMS_TOKEN=CHANGE_ME docker compose pull\n" }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: ssh({ script: 'echo "SMS_TOKEN=CHANGE_ME" > .env\ndocker compose up -d\n' }) })), "FAIL");
  // writing .env on the server from a secret via a printf slot is not a literal
  const dotenv = { env: { SMS_TOKEN: "${{ secrets.SMS_TOKEN }}" }, run: "printf \"SMS_TOKEN='%s'\\n\" \"$SMS_TOKEN\" > .env" };
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [dotenv] })) })), "PASS");
  // an obvious dummy value for a CI test step is not a leaked secret; a real-looking literal still fails
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ env: { SMS_TOKEN: "ci-placeholder" }, run: "npm test" }] })) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ run: "SMS_TOKEN=dummy npm test" }] })) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: wf(job({ steps: [{ env: { SMS_TOKEN: "k3y-9f2a7c" }, run: "npm test" }] })) })), "FAIL");
  // `key` is a cache key only on actions/cache
  assert.equal(status("W4", ctx({ workflow: step({ uses: "actions/cache/restore@v4", with: { key: "npm-1", "restore-keys": "npm-" } }) })), "PASS");
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { key: "npm-1" } }) })), "FAIL");
  // expressions: only secrets / github.token, and no literal next to them
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { password: "${{ secrets.P || 'CHANGE_ME' }}" } }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { password: "${{ env.P }}" } }) })), "FAIL");
  assert.equal(status("W4", ctx({ workflow: step({ uses: "x/y@v1", with: { secrets: "npm_token=CHANGE_ME\nother=${{ secrets.O }}\n" } }) })), "FAIL");
});

test("secret references: secrets.* and github.token only, nothing literal beside them", () => {
  for (const v of ["${{ secrets.A }}", "${{secrets.A}}", "${{ github.token }}", "${{ secrets.A || github.token }}", "a=${{ secrets.A }}\nb=${{ secrets.B }}\n"]) {
    assert.ok(isSecretReference(v), v);
  }
  for (const v of ["CHANGE_ME", "${{ vars.A }}", "${{ secrets.A || 'x' }}", "a=${{ secrets.A }}\nb=CHANGE_ME\n", ""]) assert.ok(!isSecretReference(v), v);
});

test("W5: every uses: is pinned to a version tag or a full SHA", () => {
  const steps = (...uses) => ({ jobs: { build: { steps: uses.map((u) => ({ uses: u })) } } });
  assert.equal(status("W5", ctx({ workflow: wf(steps("actions/checkout@v4", `actions/setup-node@${"c".repeat(40)}`, "./.github/actions/local", "docker://alpine:3.20")) })), "PASS");
  assert.equal(status("W5", ctx({ workflow: wf(steps("actions/checkout@main")) })), "FAIL");
  assert.equal(status("W5", ctx({ workflow: wf(steps("actions/checkout")) })), "FAIL");
  assert.equal(status("W5", ctx({ workflow: wf({ jobs: { reuse: { uses: "example/workflows/.github/workflows/ship.yml@master" } } }) })), "FAIL");
});

test("secret-like names", () => {
  const positives = ["SMS_TOKEN", "DB_PASSWORD", "API_KEY", "client-secret", "APIKEY", "GITHUB_TOKEN", "PGPASSWORD", "DBPASSWORD", "key", "ssh-key", "passphrase"];
  for (const name of positives) assert.ok(isSecretLike(name), name);
  for (const name of ["DB_PASSWORD_FILE", "KEYCLOAK_URL", "CACHE_KEY", "LOG_LEVEL", "IMAGE_TAG", "MONKEY"]) assert.ok(!isSecretLike(name), name);
});

test("npx failures are told apart from YAML errors", () => {
  const npm = (code, extra = "") => ({ status: 1, stderr: `npm error code ${code}\n${extra}npm error A complete log of this run can be found in: x.log\n` });
  assert.deepEqual(classifyYamlFailure(npm("ENOTCACHED", "npm error request to https://registry.npmjs.org/yaml failed: cache mode is 'only-if-cached'\n")), { toolError: "npm error code ENOTCACHED" });
  assert.deepEqual(classifyYamlFailure(npm("ECONNREFUSED", "npm error FetchError: request to https://registry.npmjs.org/yaml failed, reason: connect ECONNREFUSED 127.0.0.1:9\n")), { toolError: "npm error code ECONNREFUSED" });
  assert.ok(classifyYamlFailure({ code: "ETIMEDOUT", signal: "SIGTERM", stderr: "" }).toolError);
  assert.ok(classifyYamlFailure({ status: 1, stderr: "'npx' is not recognized as an internal or external command,\n" }).toolError);
  // the parser ran: a YAML error, even if the student's text quoted in the code frame says "npm error"
  const parsed = classifyYamlFailure({ status: 1, stderr: "file:///x/bin.mjs:10\n\nYAMLParseError: Map keys must be unique at line 3, column 1:\n\nnpm error code X\n^\n" });
  assert.match(parsed.error, /^YAMLParseError/);
  assert.equal(parsed.toolError, undefined);
  assert.deepEqual(classifyYamlFailure({ status: 3, stderr: "Error: Input stream contains multiple documents\n" }), { error: "Error: Input stream contains multiple documents" });
});

test("when npx cannot run, the YAML rules say so instead of blaming the files", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-tool-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "pipeline"));
    writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM example/base:2.1\nUSER app\nCMD [\"run\"]\n");
    writeFileSync(join(dir, "deploy", "compose.yaml"), "services:\n  web:\n    image: example/web:1.0.0\n");
    writeFileSync(join(dir, "pipeline", "deploy.yml"), "on: push\njobs: {}\n");
    let calls = 0;
    const offline = () => {
      calls += 1;
      return { toolError: "npm error code ENOTCACHED" };
    };
    const results = runChecks(loadContext(dir, { parse: offline }));
    assert.equal(calls, 1, "after the first failure npx is not tried again");
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const id of ["D3", "C1", "C2", "C3", "C4", "W1"]) {
      assert.equal(by[id].status, "FAIL", id);
      assert.equal(by[id].toolError, true, id);
      assert.match(by[id].message, /не вдалося запустити npx yaml@2\.8\.1 — перший запуск потребує мережі \(npm error code ENOTCACHED\)/, id);
    }
    for (const id of ["W2", "W3", "W4", "W5"]) assert.equal(by[id].status, "SKIP", id);
    assert.equal(by.D1.status, "PASS");
    const report = formatReport(results);
    assert.ok(!/підказка:/.test(report), "no rule hints when the rules could not run");
    assert.match(report, /УВАГА: npx yaml@2\.8\.1 не запустився/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the YAML parser: workflow keys stay strings, broken YAML is an error, merge keys work", () => {
  assert.deepEqual(parseYaml("on:\n  push: {}\njobs: {}\n").data, { on: { push: {} }, jobs: {} });
  assert.match(parseYaml("a: [1, 2\nb: c\n").error, /YAML/);
  assert.match(parseYaml("a: 1\na: 2\n").error, /unique|YAML/);
  assert.deepEqual(parseYaml("x: &d {restart: always}\ns:\n  <<: *d\n  image: w:1\n").data.s, { restart: "always", image: "w:1" });
});

test("the CLI prints a row per rule, survives broken YAML and exits 1 on failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-"));
  try {
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "pipeline"));
    writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM example/base:2.1\nUSER app\nCMD [\"run\"]\n");
    writeFileSync(
      join(dir, "deploy", "compose.yaml"),
      [
        "x-defaults: &defaults",
        "  restart: unless-stopped",
        "  mem_limit: 128m",
        "services:",
        "  web:",
        "    <<: *defaults",
        "    image: example/web:1.0.0",
        "    environment:",
        "      API_TOKEN: ${API_TOKEN:?missing}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "pipeline", "deploy.yml"), "on: [push\njobs:\n  a: {}\n");

    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [CHECKER, "--root", dir], { encoding: "utf8" });
    } catch (err) {
      code = err.status;
      out = err.stdout;
    }
    assert.equal(code, 1);
    const rows = Object.fromEntries(out.split("\n").filter((l) => /^[DCW]\d /.test(l)).map((l) => [l.slice(0, 2), l.slice(4, 8)]));
    assert.deepEqual(rows, {
      D1: "PASS", D2: "PASS", D3: "FAIL", D4: "PASS",
      C1: "PASS", C2: "PASS", C3: "PASS", C4: "PASS", C5: "SKIP",
      W1: "FAIL", W2: "SKIP", W3: "SKIP", W4: "SKIP", W5: "SKIP",
    });
    assert.match(out, /W1 +FAIL .*не розібрався як YAML/);
    assert.match(out, /підказка:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
