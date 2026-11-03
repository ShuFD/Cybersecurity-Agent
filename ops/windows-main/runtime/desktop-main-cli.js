import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecHeurConfig } from "./config.js";
import { CompetitionBroker } from "./competition-broker.js";
import { MainAgentController } from "./main-agent.js";
import { openWorklistOrchestrator } from "./worklist.js";
import { SecHeurBridge } from "./bridge.js";
import { DesktopCompetitionAdapter } from "./desktop-main-platform.js";
import { DesktopSolverManager } from "./desktop-main-solvers.js";

const config = loadSecHeurConfig({ env: process.env });
const stateRoot = join(config.stateDir, "desktop-main");
mkdirSync(stateRoot, { recursive: true });
const mainStatePath = join(stateRoot, "main-session.json");
function readSavedMainSessionId() {
    try {
        const saved = JSON.parse(readFileSync(mainStatePath, "utf8"));
        return typeof saved?.mainSessionId === "string" && saved.mainSessionId ? saved.mainSessionId : undefined;
    } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
    }
}
const digest = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);
const env = { ...process.env,
    SECHEUR_COMPETITION_SOCKET: process.platform === "win32"
        ? "\\\\.\\pipe\\secheur-competition-" + digest : join(stateRoot, "competition.sock"),
    WORKLIST_WORK_ROOT: join(config.projectRoot, "worklist"),
    WORKLIST_MAX_ENVIRONMENTS: "3",
};
let closing = false;
let adapter, broker, worklist, controller, bridge, solvers;
async function close(code = 0) {
    if (closing) return;
    closing = true;
    await solvers?.close?.().catch(() => undefined);
    await controller?.close?.().catch(() => undefined);
    await bridge?.close?.().catch(() => undefined);
    await broker?.close?.().catch(() => undefined);
    await worklist?.close?.().catch(() => undefined);
    await adapter?.close?.().catch(() => undefined);
    process.exit(code);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
try {
    adapter = new DesktopCompetitionAdapter(process.env.SECHEUR_PRIVATE_PLATFORM_ACCESS, stateRoot);
    let submissionSupported = false;
    try {
        const platformPolicy = await adapter.getPolicy();
        submissionSupported = platformPolicy?.raw?.submissionSupported === true;
    } catch { submissionSupported = false; }
    broker = await CompetitionBroker.open({
        databasePath: join(stateRoot, "competition.sqlite"), adapter, maxEnvironmentSlots: 3,
    });
    worklist = await openWorklistOrchestrator({
        config: { ...config, stateDir: stateRoot }, env, mode: "main", competitionBroker: broker,
        attachmentFetch: (url, init) => adapter.fetchAttachment(url, init),
    });
    controller = await MainAgentController.open({ config, env, worklist });
    bridge = new SecHeurBridge({
        projectRoot: config.projectRoot, env, host: "127.0.0.1", port: Number(env.BRIDGE_PORT ?? 14168),
        managedSessions: false, schedulerBackend: false,
        competition: broker, worklist, mainWorkflow: controller, externalCompetitionServer: true,
    });
    await bridge.listen();
    const savedMainSessionId = readSavedMainSessionId();
    let main = savedMainSessionId ? await bridge.resumeDesktopMainSession(savedMainSessionId) : undefined;
    const resumed = Boolean(main);
    if (!main) main = await bridge.createDesktopMainSession({
        title: "Main Agent", cwd: config.projectRoot, persist: true, executionMode: "direct",
        memoryReferenceEnabled: false, knowledgeBaseEnabled: false,
    });
    solvers = new DesktopSolverManager(controller, bridge, main.id, { submissionSupported });
    controller.attachMainSession(main.id, solvers);
    const summary = await controller.sync();
    if (summary.taskCount !== 20) throw new Error("Expected the selected20 platform scope");
    writeFileSync(mainStatePath, JSON.stringify({
        mainSessionId: main.id, pid: process.pid, taskCount: summary.taskCount, resumed,
        transport: "desktop-pi-session", brokerSocket: env.SECHEUR_COMPETITION_SOCKET,
        startedAt: new Date().toISOString(),
    }, null, 2));
    console.error(`SecHeur Main Agent bridge ready; 20 scoped tasks; ${resumed ? "resumed" : "new"} main session; no automatic dispatch`);
}
catch (error) {
    console.error("SecHeur Main Agent bridge failed to start: " + (error?.message ?? error));
    await close(1);
}
