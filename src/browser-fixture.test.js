import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import browserFixture from "../scripts/browser-fixture.cjs";

const chrome = browserFixture.resolveChrome();

test("browser resolver honors explicit overrides without falling back", () => {
  assert.equal(browserFixture.resolveChrome({ env: { CHROME_BIN: "/custom/chrome" },
    exists: () => { throw new Error("Override must not trigger discovery"); },
    readdir: () => { throw new Error("Override must not trigger discovery"); } }), "/custom/chrome");
});

test("browser resolver prefers installed browsers before Chrome for Testing", () => {
  for (const path of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    assert.equal(browserFixture.resolveChrome({ env: {}, exists: (candidate) => candidate === path,
      readdir: () => { throw new Error("Installed browser must not trigger temporary discovery"); } }), path);
  }
});

test("browser resolver finds existing Chrome for Testing versions in the approved temporary directory", () => {
  const expected = "/tmp/opencode/chrome-for-testing-154.0.8037.92/chrome-linux64/chrome";
  assert.equal(browserFixture.resolveChrome({ env: {},
    exists: (path) => path === expected || path.includes("chrome-for-testing-99."),
    readdir: (path) => {
      assert.equal(path, "/tmp/opencode");
      return ["unrelated", "chrome-for-testing-99.0", "chrome-for-testing-155.0", "chrome-for-testing-154.0.8037.92"];
    } }), expected);
});

test("browser resolver reports absence and does not hide discovery errors", () => {
  assert.equal(browserFixture.resolveChrome({ env: {}, exists: () => false, readdir: () => [] }), undefined);
  assert.equal(browserFixture.resolveChrome({ env: {}, exists: () => false,
    readdir: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }), undefined);
  assert.throws(() => browserFixture.resolveChrome({ env: {}, exists: () => false,
    readdir: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
});

test("CDP fixture waits for asynchronous DOM completion in an isolated profile", { timeout: 10000 }, async () => {
  assert.ok(chrome && existsSync(chrome), "Chromium is required for browser fixture validation");
  const temp = mkdtempSync(join(tmpdir(), "jr-browser-runner-"));
  try {
    const html = join(temp, "fixture.html");
    writeFileSync(html, `<!doctype html><body><pre id="result">RUNNING</pre><script>
      setTimeout(() => { const node = document.getElementById('result');
        node.textContent = 'PASS'; node.dataset.complete = 'true'; }, 100);
      </script></body>`);
    const result = await browserFixture.fixtureDOM(chrome, join(temp, "profile"), pathToFileURL(html).href,
      "document.getElementById('result')?.dataset.complete === 'true'", 5000);
    assert.match(result.stdout, /<pre id="result" data-complete="true">PASS<\/pre>/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("CDP fixture rejects a missing completion report and releases its profile", { timeout: 10000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "jr-browser-deadline-"));
  try {
    await assert.rejects(browserFixture.fixtureDOM(chrome, join(temp, "profile"), "data:text/html,<body>RUNNING",
      "false", 1500), /wall-clock timeout/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("CDP fixture reports browser launch failure without waiting for its deadline", { timeout: 10000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "jr-browser-launch-"));
  try {
    await assert.rejects(browserFixture.fixtureDOM(join(temp, "missing-chrome"), join(temp, "profile"),
      "about:blank", "true", 5000), /ENOENT/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
