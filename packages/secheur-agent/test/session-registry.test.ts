import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	competitionSocketPath,
	listSessionRegistrations,
	removeSessionRegistration,
	sessionSocketPath,
	writeSessionRegistrationAt,
} from "../src/session-registry.ts";

describe("Pi session registry", () => {
	it("persists and removes Main/Solver socket registrations", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-session-registry-"));
		try {
			const registration = {
				sessionId: "main-session",
				role: "main" as const,
				title: "Main Agent",
				socketPath: sessionSocketPath(root, "main-session"),
				pid: process.pid,
				cwd: root,
				createdAt: 1,
				updatedAt: 2,
				status: "idle" as const,
			};
			await writeSessionRegistrationAt(root, registration);

			expect(await listSessionRegistrations(root)).toEqual([registration]);
			expect(registration.socketPath.length).toBeLessThan(100);

			await removeSessionRegistration(root, registration.sessionId);
			expect(await listSessionRegistrations(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("derives a short socket path for deeply nested state directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-session-registry-long-"));
		try {
			const stateDir = join(root, "a".repeat(90), "state");
			const socketPath = sessionSocketPath(stateDir, "solver-session");
			const maximum = process.platform === "linux" ? 107 : 103;
			expect(Buffer.byteLength(socketPath)).toBeLessThan(maximum);
			expect(socketPath).not.toBe(join(stateDir, "s", `${"d".repeat(20)}.sock`));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("derives a short competition broker socket for deeply nested state directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-competition-registry-long-"));
		try {
			const stateDir = join(root, "b".repeat(90), "state");
			const socketPath = competitionSocketPath(stateDir);
			const maximum = process.platform === "linux" ? 107 : 103;
			expect(Buffer.byteLength(socketPath)).toBeLessThan(maximum);
			expect(socketPath.endsWith("competition.sock")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
