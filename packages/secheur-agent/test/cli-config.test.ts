import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	filterEnabledSkills,
	mergeDisabledTools,
	piSessionArgs,
	takeBooleanFlag,
	takeOption,
} from "../src/cli-options.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-cli-config-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SecHeur CLI options", () => {
	it("rejects a permission option without a value", () => {
		expect(takeOption(["--permission-mode", "--help"], ["--permission-mode"])).toEqual({
			args: ["--help"],
			missingValue: "--permission-mode",
		});
	});

	it("strips both knowledge-base aliases before forwarding Pi arguments", () => {
		expect(
			takeBooleanFlag(["--use-knowledge-base", "-p", "inspect", "--knowledge-base"], [
				"--use-knowledge-base",
				"--knowledge-base",
			]),
		).toEqual({ args: ["-p", "inspect"], found: true });
	});

	it("keeps the attack knowledge base disabled unless explicitly enabled", () => {
		const root = temporaryRoot();
		writeDesktopConfig(root, { knowledgeBaseEnabled: true });

		expect(loadSecHeurConfig({ projectRoot: temporaryRoot(), env: {} }).knowledgeBaseEnabled).toBe(false);
		expect(loadSecHeurConfig({ projectRoot: root, env: {} }).knowledgeBaseEnabled).toBe(true);
		for (const value of ["1", "true", "yes", "on"]) {
			expect(
				loadSecHeurConfig({ projectRoot: root, env: { SECHEUR_KNOWLEDGE_BASE_ENABLED: value } })
					.knowledgeBaseEnabled,
			).toBe(true);
		}
		for (const value of ["0", "false", "no", "off"]) {
			expect(
				loadSecHeurConfig({ projectRoot: root, env: { SECHEUR_KNOWLEDGE_BASE_ENABLED: value } })
					.knowledgeBaseEnabled,
			).toBe(false);
		}
	});

	it("merges registry and CLI tool exclusions without losing Pi arguments", () => {
		const root = temporaryRoot();
		const stateDir = join(root, ".secheur-agent");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ tools: { bash: false, write: false } }));
		const config = loadSecHeurConfig({ projectRoot: root, env: {} });

		expect(mergeDisabledTools(["-p", "inspect", "--exclude-tools=edit,bash"], config)).toEqual([
			"-p",
			"inspect",
			"--exclude-tools",
			"bash,edit,write",
		]);
		expect(mergeDisabledTools([], { ...config, knowledgeBaseEnabled: true })).toEqual([
			"--exclude-tools",
			"bash,write",
		]);
		expect(mergeDisabledTools(["--exclude-tools=attack_memory_search"], config)).toEqual([
			"--exclude-tools",
			"attack_memory_search,bash,write",
		]);
		expect(() => mergeDisabledTools(["--exclude-tools", "--print"], config)).toThrow(
			"--exclude-tools requires a value",
		);
	});

	it("injects the default prompt only for agent sessions", () => {
		const root = temporaryRoot();
		const config = { ...loadSecHeurConfig({ projectRoot: root, env: {} }), knowledgeBaseEnabled: true };

		expect(piSessionArgs(["--system-prompt=custom", "-p", "hello"], config)).toEqual([
			"-p",
			"hello",
			"--system-prompt",
			"custom",
			"--model",
			"router/auto",
			"--thinking",
			"max",
		]);
		expect(piSessionArgs(["uninstall", "npm:example"], config)).toEqual(["uninstall", "npm:example"]);
		expect(piSessionArgs(["list"], config)).toEqual(["list"]);
		expect(piSessionArgs(["-p", "hello"], config)).toEqual([
			"-p",
			"hello",
			"--system-prompt",
			config.systemPromptPath,
			"--model",
			"router/auto",
			"--thinking",
			"max",
		]);
	});

	it("filters disabled skills before Pi builds the TUI system prompt", () => {
		const root = temporaryRoot();
		const stateDir = join(root, ".secheur-agent");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ skills: { disabled: false } }));
		const config = loadSecHeurConfig({ projectRoot: root, env: {} });
		const diagnostics = [{ type: "warning" }];

		expect(
			filterEnabledSkills(config, {
				skills: [{ name: "enabled" }, { name: "disabled" }],
				diagnostics,
			}),
		).toEqual({ skills: [{ name: "enabled" }], diagnostics });
	});
});

describe("SecHeur Skill paths", () => {
	it("loads state, project, and bundled paths in declared precedence order", () => {
		const root = temporaryRoot();
		const stateDir = join(root, ".secheur-agent");
		const legacyRoot = join(root, "legacy");
		const customSkillRoot = join(root, "custom-skills");
		const stateSkill = join(stateDir, "skills", "priority-test");
		const projectSkill = join(root, "skill", "priority-test");
		mkdirSync(stateSkill, { recursive: true });
		mkdirSync(projectSkill, { recursive: true });
		writeFileSync(
			join(stateSkill, "SKILL.md"),
			"---\nname: priority-test\ndescription: State winner\n---\nState instructions.\n",
		);
		writeFileSync(
			join(projectSkill, "SKILL.md"),
			"---\nname: priority-test\ndescription: Project loser\n---\nProject instructions.\n",
		);
		writeDesktopConfig(root, {
			customSkillDirectories: `${customSkillRoot}\nrelative-skills\n${customSkillRoot}`,
		});
		const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });

		expect(config.skillPaths).toEqual([
			join(stateDir, "skills"),
			join(root, ".agents", "skills"),
			join(root, "skill"),
			join(root, "skills"),
			customSkillRoot,
			join(root, "relative-skills"),
			join(legacyRoot, ".agents", "skills"),
			join(legacyRoot, "skill"),
			join(legacyRoot, "skills"),
		]);
		const loaded = loadSkills({
			cwd: root,
			agentDir: resolve(stateDir, "pi"),
			skillPaths: config.skillPaths,
			includeDefaults: false,
		});
		expect(loaded.skills.find((skill) => skill.name === "priority-test")?.filePath).toBe(
			join(stateSkill, "SKILL.md"),
		);
	});
});
