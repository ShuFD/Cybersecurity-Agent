import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const [, , tasksPath = "reports/penetration-testing-50-tasks.json", outputDir = "/tmp/penetration-testing-task-results", workRoot = "/tmp/penetration-testing-task-work", requestedMode = "both"] = process.argv;
const tasks = JSON.parse(await readFile(resolve(tasksPath), "utf8"));
const modes = requestedMode === "both" ? ["baseline", "plugin"] : [requestedMode];
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");

await mkdir(outputDir, { recursive: true });
await mkdir(workRoot, { recursive: true });
const piScript = resolve(process.cwd(), "pi-test.sh");
const extensionPath = resolve(process.cwd(), ".pi/extensions/penetration-testing/index.ts");
const concurrency = Math.max(1, Number.parseInt(process.env.PENETRATION_TEST_CONCURRENCY ?? "3", 10) || 3);
const timeoutMs = Math.max(30_000, Number.parseInt(process.env.PENETRATION_TEST_TIMEOUT_MS ?? "180000", 10) || 180_000);
const jobs = modes.flatMap((mode) => tasks.map((task) => ({ mode, task })));
const results = [];
let cursor = 0;

function runJob({ mode, task }) {
	return new Promise((resolveJob) => {
		const id = String(task.id).padStart(2, "0");
		const runDir = join(resolve(workRoot), `${mode}-${id}`);
		const outputPath = join(resolve(outputDir), `${mode}-${id}.jsonl`);
		const stderrPath = `${outputPath}.stderr`;
		mkdir(runDir, { recursive: true }).then(() => {
			const args = [
				"--no-context-files",
				"--no-session",
				"--mode",
				"json",
				mode === "baseline" ? "--no-tools" : "--no-builtin-tools",
				"--no-extensions",
				"--provider",
				"secheur-minimax-m3-test",
				"--model",
				"MiniMax-M3",
			];
			if (mode === "plugin") args.push("--extension", extensionPath, "--approve");
			args.push("--print", task.prompt);
			const stdout = createWriteStream(outputPath, { encoding: "utf8" });
			const stderr = createWriteStream(stderrPath, { encoding: "utf8" });
			const startedAt = Date.now();
			const child = spawn(piScript, args, {
				cwd: runDir,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout.pipe(stdout);
			child.stderr.pipe(stderr);
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
			}, timeoutMs);
			child.on("error", (error) => {
				clearTimeout(timer);
				stdout.end();
				stderr.end();
				resolveJob({ mode, id: task.id, title: task.title, outputPath, stderrPath, exitCode: null, signal: error.message, timedOut, durationMs: Date.now() - startedAt });
			});
			child.on("close", (exitCode, signal) => {
				clearTimeout(timer);
				stdout.end();
				stderr.end();
				resolveJob({ mode, id: task.id, title: task.title, outputPath, stderrPath, exitCode, signal, timedOut, durationMs: Date.now() - startedAt });
			});
		});
	});
}

async function worker() {
	while (true) {
		const index = cursor++;
		if (index >= jobs.length) return;
		const result = await runJob(jobs[index]);
		results.push(result);
		process.stdout.write(`${result.mode} ${String(result.id).padStart(2, "0")} exit=${result.exitCode ?? "error"} duration=${result.durationMs}ms${result.timedOut ? " timeout" : ""}\n`);
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
results.sort((left, right) => left.mode.localeCompare(right.mode) || left.id - right.id);
await writeFile(join(resolve(outputDir), "run-summary.json"), `${JSON.stringify({ taskCount: tasks.length, modes, concurrency, timeoutMs, results }, null, 2)}\n`, "utf8");
