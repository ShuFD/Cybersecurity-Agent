import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePromptPayload } from "../src/prompt-payload.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-prompt-payload-test-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prompt payload attachments", () => {
	it("validates the complete payload before writing attachments", () => {
		const uploadDirectory = join(temporaryRoot(), "uploads");
		const imageData = Buffer.from("image").toString("base64");

		expect(() =>
			normalizePromptPayload(
				{
					prompt: "inspect",
					images: [{ id: "image-1", dataUrl: `data:image/png;base64,${imageData}` }],
					files: [{ id: "file-1", name: "broken.txt", dataUrl: "not-base64!" }],
				},
				uploadDirectory,
			),
		).toThrow("invalid file data");
		expect(existsSync(uploadDirectory)).toBe(false);
	});

	it("rejects duplicate attachment IDs before writing files", () => {
		const uploadDirectory = join(temporaryRoot(), "uploads");
		const dataUrl = `data:text/plain;base64,${Buffer.from("evidence").toString("base64")}`;

		expect(() =>
			normalizePromptPayload(
				{
					prompt: "inspect",
					files: [
						{ id: "file-1", name: "first.txt", dataUrl },
						{ id: "file-1", name: "second.txt", dataUrl },
					],
				},
				uploadDirectory,
			),
		).toThrow("duplicate file id: file-1");
		expect(existsSync(uploadDirectory)).toBe(false);
	});

	it("does not overwrite an earlier upload when a client reuses an ID", () => {
		const uploadDirectory = join(temporaryRoot(), "uploads");
		const first = normalizePromptPayload(
			{
				prompt: "first",
				files: [
					{
						id: "file-1",
						name: "notes.txt",
						dataUrl: Buffer.from("first value").toString("base64"),
					},
				],
			},
			uploadDirectory,
		);
		const second = normalizePromptPayload(
			{
				prompt: "second",
				files: [
					{
						id: "file-1",
						name: "notes.txt",
						dataUrl: Buffer.from("second value").toString("base64"),
					},
				],
			},
			uploadDirectory,
		);

		const firstPath = first.fileAttachments[0].path;
		const secondPath = second.fileAttachments[0].path;
		expect(secondPath).not.toBe(firstPath);
		expect(readFileSync(firstPath, "utf8")).toBe("first value");
		expect(readFileSync(secondPath, "utf8")).toBe("second value");
	});
});
