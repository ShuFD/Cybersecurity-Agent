import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	extractUltracodeFlagCandidates,
	registerUltracodeExtension,
	resolveUltracodeFlagVerificationMode,
	resolveUltracodeThinkingLevel,
} from "../src/ultracode.ts";

describe("ultracode extension registration", () => {
	it("defaults candidate reasoning to max and accepts an explicit override", () => {
		const previous = process.env.ULTRACODE_THINKING_LEVEL;
		try {
			delete process.env.ULTRACODE_THINKING_LEVEL;
			expect(resolveUltracodeThinkingLevel()).toBe("max");
			process.env.ULTRACODE_THINKING_LEVEL = "high";
			expect(resolveUltracodeThinkingLevel()).toBe("high");
			process.env.ULTRACODE_THINKING_LEVEL = "invalid";
			expect(() => resolveUltracodeThinkingLevel()).toThrow("ULTRACODE_THINKING_LEVEL");
		} finally {
			if (previous === undefined) delete process.env.ULTRACODE_THINKING_LEVEL;
			else process.env.ULTRACODE_THINKING_LEVEL = previous;
		}
	});

	it("never treats a flag-shaped string as oracle verification", () => {
		const previous = process.env.ULTRACODE_FLAG_VERIFY;
		try {
			delete process.env.ULTRACODE_FLAG_VERIFY;
			expect(resolveUltracodeFlagVerificationMode()).toBe("auto");
			process.env.ULTRACODE_FLAG_VERIFY = "required";
			expect(resolveUltracodeFlagVerificationMode()).toBe("required");
			expect(extractUltracodeFlagCandidates("candidate: DASCTF{guess}")).toEqual(["DASCTF{guess}"]);
			expect(extractUltracodeFlagCandidates("DASCTF{first} and flag{second}")).toHaveLength(2);
		} finally {
			if (previous === undefined) delete process.env.ULTRACODE_FLAG_VERIFY;
			else process.env.ULTRACODE_FLAG_VERIFY = previous;
		}
	});

	it("registers the flag, control commands, and lifecycle hooks", () => {
		const flags: string[] = [];
		const commands: string[] = [];
		const commandHandlers = new Map<string, (args: string, ctx: unknown) => unknown>();
		const events: string[] = [];
		const pi = {
			registerFlag(name: string) {
				flags.push(name);
			},
			registerTool() {},
			registerCommand(name: string, command: { handler?: (args: string, ctx: unknown) => unknown }) {
				commands.push(name);
				if (command.handler) commandHandlers.set(name, command.handler);
			},
			on(event: string) {
				events.push(event);
			},
			sendUserMessage() {},
			getFlag() {
				return false;
			},
		} as unknown as ExtensionAPI;

		registerUltracodeExtension(pi);

		expect(flags).toContain("ultracode");
		expect(commands).toEqual(expect.arrayContaining(["ultracode", "normal"]));
		expect(events).toEqual(expect.arrayContaining(["session_start", "input", "session_shutdown"]));
	});

	it("enables continuous mode for a bare ultracode command", async () => {
		const commandHandlers = new Map<string, (args: string, ctx: unknown) => unknown>();
		const notifications: string[] = [];
		const pi = {
			registerFlag() {},
			registerTool() {},
			registerCommand(name: string, command: { handler?: (args: string, ctx: unknown) => unknown }) {
				if (command.handler) commandHandlers.set(name, command.handler);
			},
			on() {},
			sendUserMessage() {},
			getFlag() {
				return false;
			},
		} as unknown as ExtensionAPI;

		registerUltracodeExtension(pi);
		const handler = commandHandlers.get("ultracode");
		if (!handler) throw new Error("ultracode command handler was not registered");
		const ctx = {
			hasUI: true,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				setStatus() {},
			},
		};

		await handler("", ctx);
		await handler("status", ctx);

		expect(notifications).toEqual(["Ultracode enabled", "Ultracode is enabled"]);
	});
});
