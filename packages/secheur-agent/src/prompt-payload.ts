import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

const IMAGE_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const FILE_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const MAX_IMAGES = 4;
const MAX_FILES = 8;
const MAX_TEXT_CHARS = 400_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

interface JsonObject {
	[key: string]: unknown;
}

export interface BridgeImageAttachment {
	id: string;
	name: string;
	path: string;
}

export interface BridgeFileAttachment {
	id: string;
	name: string;
	type: string;
	size: number;
	path: string;
}

export interface NormalizedPromptPayload {
	prompt: string;
	displayPrompt: string;
	images: ImageContent[];
	imageIds: string[];
	imageAttachments: BridgeImageAttachment[];
	fileAttachments: BridgeFileAttachment[];
}

interface PreparedAttachment {
	bytes: Buffer;
	path: string;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function promptText(value: unknown, discoveredImages?: unknown[]): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return value === undefined || value === null ? "" : String(value);
	const parts: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			parts.push(item);
			continue;
		}
		if (!isRecord(item)) continue;
		if (item.type === "text" || item.type === "input_text") {
			parts.push(String(item.text ?? item.content ?? ""));
			continue;
		}
		if (item.type !== "image" && item.type !== "input_image") continue;
		let image: unknown = item.image_url ?? item.url ?? item.data;
		if (isRecord(image)) image = image.url;
		if (image !== undefined && discoveredImages) discoveredImages.push(image);
	}
	return parts.filter(Boolean).join("\n");
}

function decodeBase64(value: string, maximumBytes: number, kind: string): Buffer {
	if (!value || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1) {
		throw new Error(`invalid ${kind} data`);
	}
	const decoded = Buffer.from(value, "base64");
	const canonicalInput = value.replace(/=+$/u, "");
	const canonicalOutput = decoded.toString("base64").replace(/=+$/u, "");
	if (canonicalInput !== canonicalOutput) throw new Error(`invalid ${kind} data`);
	if (decoded.length > maximumBytes) throw new Error(`${kind} data exceeds size limit`);
	return decoded;
}

function imageData(value: unknown): { bytes: Buffer; mimeType: string; extension: string } {
	const raw = String(value ?? "");
	let mimeType = "image/png";
	let encoded = raw;
	if (raw.startsWith("data:")) {
		const comma = raw.indexOf(",");
		if (comma < 0) throw new Error("invalid image data");
		const header = raw.slice(0, comma);
		const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64$/iu.exec(header);
		if (!match) throw new Error("unsupported image data URL");
		mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
		encoded = raw.slice(comma + 1);
	}
	const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
	return { bytes: decodeBase64(encoded, MAX_IMAGE_BYTES, "image"), mimeType, extension };
}

function fileData(value: unknown): Buffer {
	const raw = String(value ?? "");
	const comma = raw.startsWith("data:") ? raw.indexOf(",") : -1;
	if (raw.startsWith("data:") && comma < 0) throw new Error("invalid file data");
	return decodeBase64(comma >= 0 ? raw.slice(comma + 1) : raw, MAX_FILE_BYTES, "file");
}

function attachmentId(value: unknown, pattern: RegExp, prefix: string): string {
	const id = typeof value === "string" && value ? value : `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	if (!pattern.test(id)) throw new Error(`invalid ${prefix} id`);
	return id;
}

function fileName(value: unknown): string {
	const name = String(value ?? "upload.bin").trim() || "upload.bin";
	if (name.length > 180) throw new Error("file name is too long");
	if (basename(name) !== name || name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(name)) {
		throw new Error("invalid file name");
	}
	return name;
}

export function normalizePromptPayload(input: JsonObject, uploadDirectory: string): NormalizedPromptPayload {
	const discoveredImages: unknown[] = [];
	const rawText = promptText(input.prompt ?? input.content ?? input.message, discoveredImages);
	if (rawText.length > MAX_TEXT_CHARS) throw new Error(`prompt exceeds size limit: max ${MAX_TEXT_CHARS} chars`);
	const suppliedImages = input.images === undefined ? [] : input.images;
	const suppliedFiles = input.files === undefined ? [] : input.files;
	if (!Array.isArray(suppliedImages)) throw new Error("images must be an array");
	if (!Array.isArray(suppliedFiles)) throw new Error("files must be an array");
	const imageInputs = [...discoveredImages, ...suppliedImages];
	if (imageInputs.length > MAX_IMAGES) throw new Error(`too many images: max ${MAX_IMAGES}`);
	if (suppliedFiles.length > MAX_FILES) throw new Error(`too many files: max ${MAX_FILES}`);

	const images: ImageContent[] = [];
	const imageIds: string[] = [];
	const imageAttachments: BridgeImageAttachment[] = [];
	const imageTags: string[] = [];
	const prepared: PreparedAttachment[] = [];
	const usedImageIds = new Set<string>();
	for (const item of imageInputs) {
		const record = isRecord(item) ? item : {};
		const id = attachmentId(record.id, IMAGE_ID, "img");
		if (usedImageIds.has(id)) throw new Error(`duplicate image id: ${id}`);
		usedImageIds.add(id);
		const data = imageData(record.dataUrl ?? record.data_url ?? (isRecord(item) ? "" : item));
		if (data.bytes.length === 0) throw new Error("empty image data");
		const storageId = randomUUID().replaceAll("-", "");
		const path = join(uploadDirectory, `${id}-${storageId}.${data.extension}`);
		prepared.push({ bytes: data.bytes, path });
		images.push({ type: "image", data: data.bytes.toString("base64"), mimeType: data.mimeType });
		imageIds.push(id);
		imageAttachments.push({ id, name: String(record.name ?? "image"), path });
		imageTags.push(`[image:${path}]`);
	}

	const fileAttachments: BridgeFileAttachment[] = [];
	const fileTags: string[] = [];
	const usedFileIds = new Set<string>();
	for (const item of suppliedFiles) {
		if (!isRecord(item)) throw new Error("invalid file attachment");
		const id = attachmentId(item.id, FILE_ID, "file");
		if (usedFileIds.has(id)) throw new Error(`duplicate file id: ${id}`);
		usedFileIds.add(id);
		const name = fileName(item.name);
		const dataUrl = item.dataUrl ?? item.data_url;
		if (typeof dataUrl !== "string" || !dataUrl) throw new Error("file attachment missing data");
		const bytes = fileData(dataUrl);
		const type = String(item.type ?? "application/octet-stream").slice(0, 120);
		const storageId = randomUUID().replaceAll("-", "");
		const path = join(uploadDirectory, `${id}-${storageId}-${name}`);
		prepared.push({ bytes, path });
		fileAttachments.push({ id, name, type, size: bytes.length, path });
		fileTags.push(
			`<uploaded_file name="${xmlEscape(name)}" type="${xmlEscape(type)}" size="${bytes.length}">\n${xmlEscape(path)}\n</uploaded_file>`,
		);
	}

	const suffix = [...imageTags, ...fileTags].join("\n\n");
	const prompt = [rawText, suffix].filter(Boolean).join("\n\n");
	const displayValue = input.displayPrompt ?? input.display_prompt;
	const displayPrompt = displayValue === undefined ? rawText : promptText(displayValue);
	if (!prompt.trim() && images.length === 0 && fileAttachments.length === 0) {
		throw new Error("prompt, images or files is required");
	}
	if (prepared.length > 0) {
		mkdirSync(uploadDirectory, { recursive: true });
		const writtenPaths: string[] = [];
		try {
			for (const attachment of prepared) {
				writtenPaths.push(attachment.path);
				writeFileSync(attachment.path, attachment.bytes, { flag: "wx", mode: 0o600 });
			}
		} catch (error) {
			for (const path of writtenPaths.reverse()) {
				try {
					rmSync(path, { force: true });
				} catch {
					// 保留原始写入错误。
				}
			}
			throw error;
		}
	}
	return { prompt, displayPrompt, images, imageIds, imageAttachments, fileAttachments };
}
