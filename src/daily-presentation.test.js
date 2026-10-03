import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import browserFixture from "../scripts/browser-fixture.cjs";
import { DAILY_PRESENTATION_STYLE } from "./daily-presentation.js";

// Renderer-shaped DOM fixture only; not Logseq Desktop query execution/rendering.
test("Chromium presentation hides only empty marked sections and preserves tasks, errors and user content", { timeout: 40000 }, async () => {
  const chrome = browserFixture.resolveChrome();
  assert.ok(chrome && existsSync(chrome), "Chromium is required for the native-shaped presentation fixture");
  const temp = mkdtempSync(join(tmpdir(), "jr-daily-presentation-"));
  try {
    function section(id, kind, result, extra = "") {
      const marker = kind ? `<span data-jr-query="${kind}"></span>` : "";
      return `<div id="${id}" class="ls-block"><div class="block-main-container">Section heading</div>
        <div class="block-children-container" style="margin-left:24px;padding-left:8px">
        <div class="block-children-left-border"></div><div class="block-children">
        <div class="ls-block"><div class="block-main-container"><div class="block-control-wrap"><span class="bullet-container">•</span></div>
        <div class="custom-query"><div class="th">${marker}</div><div class="bd">${result}</div></div>
        </div></div>${extra}</div></div></div>`;
    }
    const empty = '<div class="custom-query-results"><div class="text-sm mt-2 opacity-90">No matched result</div></div>';
    const task = '<div class="custom-query-results"><div class="ls-block" data-query="true"><div class="block-main-container"><div class="block-control-wrap"><span class="bullet-container">•</span></div>TODO original task</div></div></div>';
    const html = `<!doctype html><meta charset="utf-8"><style>${DAILY_PRESENTATION_STYLE}</style>
      ${section("priority-empty", "priority", empty)}${section("pending-empty", "pending", empty)}
      ${section("weekly-empty", "weekly", empty)}${section("priority-task", "priority", task)}
      ${section("pending-error", "pending", '<div class="warning">Query error</div>')}
      ${section("pending-unrendered", "pending", "")}
      ${section("priority-note", "priority", empty, '<div class="ls-block">My extra note</div>')}
      ${section("unrelated-empty", null, empty)}
      <script>
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      const result = {
        priorityHidden: !shown('priority-empty'), pendingHidden: !shown('pending-empty'),
        weeklyVisible: shown('weekly-empty'), taskVisible: shown('priority-task'),
        errorVisible: shown('pending-error'), unrenderedVisible: shown('pending-unrendered'),
        noteVisible: shown('priority-note'), unrelatedVisible: shown('unrelated-empty'),
        compact: getComputedStyle(document.querySelector('#priority-task > .block-children-container')).marginLeft === '0px',
        wrapperBulletHidden: getComputedStyle(document.querySelector('#priority-task .block-children .ls-block > .block-main-container > .block-control-wrap .bullet-container')).visibility === 'hidden',
        taskBulletVisible: getComputedStyle(document.querySelector('#priority-task [data-query] .bullet-container')).visibility === 'visible'
      };
      const output = document.createElement('pre'); output.id = 'result'; output.textContent = encodeURIComponent(JSON.stringify(result)); document.body.append(output);
      </script>`;
    const file = join(temp, "fixture.html"); writeFileSync(file, html);
    const result = await browserFixture.fixtureDOM(chrome, join(temp, "profile"), pathToFileURL(file).href,
      "!!document.getElementById('result')");
    const match = /<pre id="result">([^<]+)<\/pre>/.exec(result.stdout);
    assert.ok(match, "Chromium must return the DOM assertions");
    const report = JSON.parse(decodeURIComponent(match[1]));
    for (const [key, passed] of Object.entries(report)) assert.equal(passed, true, key);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
