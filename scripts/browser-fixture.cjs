"use strict";

const { spawn } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

function resolveChrome({ env = process.env, exists = existsSync, readdir = readdirSync } = {}) {
  // An explicit override must not silently select a different browser.
  if (env.CHROME_BIN) return env.CHROME_BIN;
  const system = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(exists);
  if (system) return system;
  let entries;
  try { entries = readdir("/tmp/opencode"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  return entries.filter((name) => /^chrome-for-testing-\d+(?:\.\d+)*$/.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map((name) => join("/tmp/opencode", name, "chrome-linux64", "chrome"))
    .find(exists);
}

// Real-time CDP avoids relying on dump-dom/virtual-time browser shutdown.
async function fixtureDOM(chrome, profile, url, complete, timeout = 30000) {
  const child = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"],
  { detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const pending = new Map();
  let sequence = 0, buffer = "", stderr = "", failure;
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure ||= error; }
  };
  const rejectPending = (error) => {
    failure ||= error;
    for (const handler of pending.values()) handler.reject(error);
    pending.clear();
  };
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.once("error", rejectPending);
  child.once("exit", () => { rejectPending(new Error("Chrome fixture exited before completion")); kill(); });
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-12000); });
  child.stdio[3].on("error", rejectPending);
  child.stdio[4].on("error", rejectPending);
  child.stdio[4].on("data", (data) => {
    buffer += data.toString();
    if (buffer.length > 16 * 1024 * 1024) {
      rejectPending(new Error("Chrome fixture protocol output exceeded 16 MiB")); kill(); return;
    }
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const text = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(text), handler = pending.get(message.id);
        if (handler) {
          pending.delete(message.id);
          message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
        }
      } catch (error) { rejectPending(error); kill(); }
    }
  });
  function call(method, params = {}, sessionId) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  const timer = setTimeout(() => {
    rejectPending(new Error(`Chrome fixture exceeded ${timeout}-millisecond wall-clock timeout`)); kill();
  }, timeout);
  try {
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const navigation = await call("Page.navigate", { url }, sessionId);
    if (navigation.errorText) throw new Error(navigation.errorText);
    for (;;) {
      const response = await call("Runtime.evaluate", {
        expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && (${complete})`,
        returnByValue: true,
      }, sessionId);
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      if (response.result?.value === true) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const response = await call("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    if (typeof response.result?.value !== "string") throw new Error("Chrome returned no fixture DOM");
    if (response.result.value.length > 8 * 1024 * 1024) throw new Error("Chrome DOM output exceeded 8 MiB");
    return { stdout: response.result.value, stderr };
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`, { cause: error });
  } finally {
    clearTimeout(timer);
    rejectPending(new Error("Browser fixture closed"));
    kill();
    await closed;
  }
}

module.exports = { fixtureDOM, resolveChrome };
