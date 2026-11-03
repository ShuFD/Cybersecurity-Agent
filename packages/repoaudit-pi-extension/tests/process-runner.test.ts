import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess } from "../src/adapter/process-runner.ts";
import {
  abortCodeFromRuntimeOptions,
  processTerminationError,
  withRepoAuditLock,
} from "../src/adapter/run-repoaudit.ts";

function request(args: readonly string[], timeoutMs = 5_000) {
  return {
    command: process.execPath,
    args,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs,
  };
}

test("process runner 捕获 stdout/stderr/exitCode", async () => {
  const result = await runProcess(
    request(["-e", "process.stdout.write('out'); process.stderr.write('err')"]),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.stdoutBytes, 3);
  assert.equal(result.stderrBytes, 3);
});

test("process runner 保留非零 exitCode", async () => {
  const result = await runProcess(request(["-e", "process.exit(7)"]));
  assert.equal(result.exitCode, 7);
  assert.equal(result.aborted, false);
  assert.equal(result.timedOut, false);
});

test("repoPath 含空格与中文时保持单个 argv", async () => {
  const value = "C:/含 空格/中文仓库";
  const result = await runProcess(
    request(["-e", "process.stdout.write(process.argv[1])", value]),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, value);
});

test("AbortSignal 终止父进程及其子进程树并只完成一次", async (t) => {
  const pidFile = path.join(os.tmpdir(), `repoaudit-child-${process.pid}-${Date.now()}.pid`);
  t.after(() => rm(pidFile, { force: true }));
  const controller = new AbortController();
  const pending = runProcess({
    ...request([
      "-e",
      "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)",
      pidFile,
    ], 5_000),
    signal: controller.signal,
  });
  let childPid = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      childPid = Number(await readFile(pidFile, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(childPid, 0));
});

test("timeout 终止进程树", async () => {
  const result = await runProcess(
    request(["-e", "setInterval(() => {}, 1000)"], 100),
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
});

test("进程内 mutex 串行化两个执行", async () => {
  const events: string[] = [];
  const first = withRepoAuditLock(async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 60));
    events.push("first:end");
  });
  const second = withRepoAuditLock(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("等待 mutex 时 abort 不会执行 action", async () => {
  const controller = new AbortController();
  const first = withRepoAuditLock(
    () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
  );
  let ran = false;
  const second = withRepoAuditLock(async () => {
    ran = true;
  }, controller.signal);
  const rejected = assert.rejects(second);
  controller.abort();
  await first;
  await rejected;
  assert.equal(ran, false);
});

test("plugin timeout and AbortSignal cancellation have distinct stable codes", () => {
  assert.equal(
    processTerminationError({ aborted: false, timedOut: true }, {})?.code,
    "SCAN_TIMEOUT",
  );
  assert.equal(
    processTerminationError({ aborted: true, timedOut: false }, {})?.code,
    "USER_ABORTED",
  );
});

test("HOST_WATCHDOG_ABORTED requires an explicit abort source or reason", () => {
  assert.equal(abortCodeFromRuntimeOptions({}), "USER_ABORTED");
  assert.equal(abortCodeFromRuntimeOptions({ abortSource: "host_watchdog" }), "HOST_WATCHDOG_ABORTED");
  const controller = new AbortController();
  controller.abort({ source: "host_watchdog" });
  assert.equal(abortCodeFromRuntimeOptions({ signal: controller.signal }), "HOST_WATCHDOG_ABORTED");
  const unknown = new AbortController();
  unknown.abort("idle timeout maybe");
  assert.equal(abortCodeFromRuntimeOptions({ signal: unknown.signal }), "USER_ABORTED");
});
