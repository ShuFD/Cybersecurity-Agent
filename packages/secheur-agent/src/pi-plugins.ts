import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	type PackageSource,
	type ResolvedPaths,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SecHeurConfig } from "./config.ts";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
const DESKTOP_UI_ASSET_TYPES = ["styles", "scripts"] as const;
const DESKTOP_UI_ASSET_EXTENSIONS = { styles: ".css", scripts: ".js" } as const;

export type PiPluginScope = "user" | "project";
type PiPluginSourceType = "npm" | "git" | "local";
type PiPluginResourceType = (typeof RESOURCE_TYPES)[number];
export type DesktopUiPluginAssetType = (typeof DESKTOP_UI_ASSET_TYPES)[number];

export interface DesktopUiPluginResourceCounts {
	styles: number;
	scripts: number;
}

export interface PiPluginResourceCounts {
	extensions: number;
	skills: number;
	prompts: number;
	themes: number;
}

export interface PiPluginInfo {
	source: string;
	scope: PiPluginScope;
	sourceType: PiPluginSourceType;
	name: string;
	version?: string;
	description?: string;
	installed: boolean;
	installedPath?: string;
	enabled: boolean;
	filtered: boolean;
	resources: PiPluginResourceCounts;
	activeResources: PiPluginResourceCounts;
	desktopUi: DesktopUiPluginResourceCounts;
	diagnostics: string[];
}

export interface DesktopUiPluginInfo {
	id: string;
	name: string;
	version?: string;
	description?: string;
	scope: PiPluginScope;
	styles: string[];
	scripts: string[];
}

export interface DesktopUiPluginSnapshot {
	plugins: DesktopUiPluginInfo[];
	diagnostics: PiPluginDiagnostic[];
}

export interface PiPluginDiagnostic {
	level: "warning" | "error";
	message: string;
	scope?: PiPluginScope;
	source?: string;
}

export interface PiPluginSnapshot {
	plugins: PiPluginInfo[];
	diagnostics: PiPluginDiagnostic[];
	settingsPaths: {
		user: string;
		project: string;
	};
}

interface PackageMetadata {
	name?: string;
	version?: string;
	description?: string;
	error?: string;
	desktopUi: Record<DesktopUiPluginAssetType, string[]>;
	desktopUiDiagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyResourceCounts(): PiPluginResourceCounts {
	return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function emptyResolvedPaths(): ResolvedPaths {
	return { extensions: [], skills: [], prompts: [], themes: [] };
}

function emptyDesktopUiAssets(): Record<DesktopUiPluginAssetType, string[]> {
	return { styles: [], scripts: [] };
}

function sourceOf(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

function packageEntries(settingsManager: SettingsManager, scope: PiPluginScope): PackageSource[] {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	return [...(settings.packages ?? [])];
}

function writePackageEntries(settingsManager: SettingsManager, scope: PiPluginScope, entries: PackageSource[]): void {
	if (scope === "project") settingsManager.setProjectPackages(entries);
	else settingsManager.setPackages(entries);
}

function configuredEntry(
	settingsManager: SettingsManager,
	scope: PiPluginScope,
	source: string,
): PackageSource | undefined {
	return packageEntries(settingsManager, scope).find((entry) => sourceOf(entry) === source);
}

function sourceType(source: string): PiPluginSourceType {
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git:") || /^(?:https?|ssh|git):\/\//iu.test(source) || /^[^@\s]+@[^:\s]+:/u.test(source)) {
		return "git";
	}
	return "local";
}

function sourceName(source: string): string {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4);
		const versionSeparator = spec.lastIndexOf("@");
		return versionSeparator > spec.indexOf("/") ? spec.slice(0, versionSeparator) : spec;
	}
	const withoutRef = source.replace(/@[^/\\]+$/u, "");
	return basename(withoutRef.replace(/[\\/]+$/u, "")).replace(/\.git$/iu, "") || source;
}

function pathInside(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function readDesktopUiAssets(
	packageJson: Record<string, unknown>,
	installedPath: string,
): { assets: Record<DesktopUiPluginAssetType, string[]>; diagnostics: string[] } {
	const assets = emptyDesktopUiAssets();
	const diagnostics: string[] = [];
	if (packageJson.secheur === undefined) return { assets, diagnostics };
	if (!isRecord(packageJson.secheur)) {
		return { assets, diagnostics: ["package.json secheur field must contain an object"] };
	}
	const desktop = packageJson.secheur.desktop;
	if (desktop === undefined) return { assets, diagnostics };
	if (!isRecord(desktop)) {
		return { assets, diagnostics: ["package.json secheur.desktop field must contain an object"] };
	}
	for (const type of DESKTOP_UI_ASSET_TYPES) {
		const entries = desktop[type];
		if (entries === undefined) continue;
		if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
			diagnostics.push(`secheur.desktop.${type} must contain only relative file paths`);
			continue;
		}
		const seen = new Set<string>();
		for (const entry of entries) {
			const declaredPath = entry.trim();
			if (!declaredPath || declaredPath.includes("\0") || isAbsolute(declaredPath)) {
				diagnostics.push(`Invalid Desktop UI ${type} path: ${entry}`);
				continue;
			}
			const target = resolve(installedPath, declaredPath);
			if (
				!pathInside(installedPath, target) ||
				extname(target).toLowerCase() !== DESKTOP_UI_ASSET_EXTENSIONS[type]
			) {
				diagnostics.push(`Invalid Desktop UI ${type} path: ${entry}`);
				continue;
			}
			try {
				if (!statSync(target).isFile()) throw new Error("not a file");
				const realRoot = realpathSync(installedPath);
				const realTarget = realpathSync(target);
				if (!pathInside(realRoot, realTarget)) throw new Error("outside plugin root");
				if (!seen.has(realTarget)) {
					seen.add(realTarget);
					assets[type].push(realTarget);
				}
			} catch {
				diagnostics.push(`Desktop UI ${type} file was not found inside the plugin: ${entry}`);
			}
		}
	}
	return { assets, diagnostics };
}

function readPackageMetadata(installedPath: string | undefined): PackageMetadata {
	if (!installedPath || !existsSync(installedPath)) {
		return { desktopUi: emptyDesktopUiAssets(), desktopUiDiagnostics: [] };
	}
	try {
		if (!statSync(installedPath).isDirectory()) {
			return { name: basename(installedPath), desktopUi: emptyDesktopUiAssets(), desktopUiDiagnostics: [] };
		}
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) {
			return { name: basename(installedPath), desktopUi: emptyDesktopUiAssets(), desktopUiDiagnostics: [] };
		}
		const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (!isRecord(parsed)) {
			return {
				name: basename(installedPath),
				error: "package.json must contain an object",
				desktopUi: emptyDesktopUiAssets(),
				desktopUiDiagnostics: [],
			};
		}
		const desktopUi = readDesktopUiAssets(parsed, installedPath);
		return {
			...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
			...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
			...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
			desktopUi: desktopUi.assets,
			desktopUiDiagnostics: desktopUi.diagnostics,
		};
	} catch (error) {
		return {
			name: basename(installedPath),
			error: error instanceof Error ? error.message : String(error),
			desktopUi: emptyDesktopUiAssets(),
			desktopUiDiagnostics: [],
		};
	}
}

function countResources(
	resolved: ResolvedPaths,
	predicate: (resource: ResolvedPaths[PiPluginResourceType][number]) => boolean,
): PiPluginResourceCounts {
	const counts = emptyResourceCounts();
	for (const type of RESOURCE_TYPES) counts[type] = resolved[type].filter(predicate).length;
	return counts;
}

function hasResources(counts: PiPluginResourceCounts): boolean {
	return RESOURCE_TYPES.some((type) => counts[type] > 0);
}

function hasDesktopUiResources(assets: Record<DesktopUiPluginAssetType, string[]>): boolean {
	return DESKTOP_UI_ASSET_TYPES.some((type) => assets[type].length > 0);
}

function desktopUiResourceCounts(assets: Record<DesktopUiPluginAssetType, string[]>): DesktopUiPluginResourceCounts {
	return { styles: assets.styles.length, scripts: assets.scripts.length };
}

function desktopUiPluginId(scope: PiPluginScope, source: string): string {
	return createHash("sha256").update(`${scope}\0${source}`).digest("hex").slice(0, 24);
}

type ConfiguredPackage = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];

interface DesktopUiPackageCandidate {
	pkg: ConfiguredPackage;
	scope: PiPluginScope;
	enabled: boolean;
	installedPath?: string;
}

function desktopUiPackageIdentity(config: SecHeurConfig, pkg: ConfiguredPackage): string {
	// Local packages can be referenced with different relative paths from user and
	// project settings. Resolve their real path so the same UI asset is loaded once.
	if (pkg.installedPath) {
		try {
			return `path:${realpathSync(pkg.installedPath)}`;
		} catch {
			return `path:${resolve(pkg.installedPath)}`;
		}
	}
	if (pkg.source.startsWith("npm:")) return `npm:${sourceName(pkg.source)}`;
	if (sourceType(pkg.source) === "git") {
		return `git:${pkg.source.replace(/^git:/u, "").replace(/\.git(?:@[^/]+)?$/u, "")}`;
	}
	const base = pkg.scope === "project" ? join(config.projectRoot, CONFIG_DIR_NAME) : config.agentDir;
	return `local:${resolve(base, pkg.source)}`;
}

function effectiveDesktopUiPackages(
	config: SecHeurConfig,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): DesktopUiPackageCandidate[] {
	const selected = new Map<string, DesktopUiPackageCandidate>();
	for (const pkg of packageManager.listConfiguredPackages()) {
		const scope = pkg.scope;
		const rawEntry = configuredEntry(settingsManager, scope, pkg.source);
		const candidate: DesktopUiPackageCandidate = {
			pkg,
			scope,
			enabled: typeof rawEntry === "string" || rawEntry?.autoload !== false,
			...(pkg.installedPath ? { installedPath: pkg.installedPath } : {}),
		};
		const identity = desktopUiPackageIdentity(config, pkg);
		const previous = selected.get(identity);
		// Package manager semantics give a project entry precedence over a user
		// entry, including an explicit project autoload=false override.
		if (!previous || (previous.scope === "user" && scope === "project")) selected.set(identity, candidate);
	}
	return [...selected.values()];
}

function createPackageManager(config: SecHeurConfig): {
	settingsManager: SettingsManager;
	packageManager: DefaultPackageManager;
} {
	const settingsManager = SettingsManager.create(config.projectRoot, config.agentDir);
	return {
		settingsManager,
		packageManager: new DefaultPackageManager({
			cwd: config.projectRoot,
			agentDir: config.agentDir,
			settingsManager,
		}),
	};
}

export function parsePiPluginScope(value: unknown): PiPluginScope {
	if (value === undefined || value === null || value === "" || value === "user") return "user";
	if (value === "project") return "project";
	throw new Error("Plugin scope must be user or project");
}

export function parsePiPluginSource(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Plugin source is required");
	const source = value.trim();
	if (source.length > 4096) throw new Error("Plugin source is too long");
	if (source.includes("\0")) throw new Error("Plugin source contains an invalid null byte");
	return source;
}

export async function listPiPlugins(config: SecHeurConfig): Promise<PiPluginSnapshot> {
	const { settingsManager, packageManager } = createPackageManager(config);
	const diagnostics: PiPluginDiagnostic[] = settingsManager.drainErrors().map(({ scope, error }) => ({
		level: "error",
		message: error.message,
		scope: scope === "global" ? "user" : "project",
	}));
	let activeResolved = emptyResolvedPaths();
	try {
		activeResolved = await packageManager.resolve(async () => "skip");
	} catch (error) {
		diagnostics.push({
			level: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	const plugins: PiPluginInfo[] = [];
	for (const pkg of packageManager.listConfiguredPackages()) {
		const scope = pkg.scope;
		const rawEntry = configuredEntry(settingsManager, scope, pkg.source);
		const enabled = typeof rawEntry === "string" || rawEntry?.autoload !== false;
		const pluginDiagnostics: string[] = [];
		const metadata = readPackageMetadata(pkg.installedPath);
		if (!pkg.installedPath) pluginDiagnostics.push("Package is configured but not installed");
		if (metadata.error) pluginDiagnostics.push(`Could not read package.json: ${metadata.error}`);
		pluginDiagnostics.push(...metadata.desktopUiDiagnostics);

		let allResolved = emptyResolvedPaths();
		if (pkg.installedPath) {
			try {
				allResolved = await packageManager.resolveExtensionSources([pkg.installedPath], { temporary: true });
			} catch (error) {
				pluginDiagnostics.push(error instanceof Error ? error.message : String(error));
			}
		}
		const resources = countResources(allResolved, () => true);
		const activeResources = countResources(
			activeResolved,
			(resource) =>
				resource.enabled &&
				resource.metadata.origin === "package" &&
				resource.metadata.scope === scope &&
				resource.metadata.source === pkg.source,
		);
		if (pkg.installedPath && !hasResources(resources) && !hasDesktopUiResources(metadata.desktopUi)) {
			pluginDiagnostics.push("No Pi extensions, skills, prompts, or themes were discovered");
		}

		plugins.push({
			source: pkg.source,
			scope,
			sourceType: sourceType(pkg.source),
			name: metadata.name || sourceName(pkg.source),
			...(metadata.version ? { version: metadata.version } : {}),
			...(metadata.description ? { description: metadata.description } : {}),
			installed: Boolean(pkg.installedPath),
			...(pkg.installedPath ? { installedPath: pkg.installedPath } : {}),
			enabled,
			filtered: pkg.filtered,
			resources,
			activeResources,
			desktopUi: desktopUiResourceCounts(metadata.desktopUi),
			diagnostics: pluginDiagnostics,
		});
		for (const message of pluginDiagnostics) {
			diagnostics.push({ level: "warning", message, scope, source: pkg.source });
		}
	}

	plugins.sort(
		(left, right) =>
			left.scope.localeCompare(right.scope) ||
			left.name.localeCompare(right.name) ||
			left.source.localeCompare(right.source),
	);
	return {
		plugins,
		diagnostics,
		settingsPaths: {
			user: join(config.agentDir, "settings.json"),
			project: join(config.projectRoot, CONFIG_DIR_NAME, "settings.json"),
		},
	};
}

export function listDesktopUiPlugins(config: SecHeurConfig): DesktopUiPluginSnapshot {
	const { settingsManager, packageManager } = createPackageManager(config);
	const plugins: DesktopUiPluginInfo[] = [];
	const diagnostics: PiPluginDiagnostic[] = [];
	for (const candidate of effectiveDesktopUiPackages(config, settingsManager, packageManager)) {
		const { pkg, scope, enabled, installedPath } = candidate;
		if (!enabled || !installedPath) continue;
		const metadata = readPackageMetadata(installedPath);
		for (const message of metadata.desktopUiDiagnostics) {
			diagnostics.push({ level: "warning", message, scope, source: pkg.source });
		}
		if (metadata.error) {
			diagnostics.push({
				level: "error",
				message: `Could not read package.json: ${metadata.error}`,
				scope,
				source: pkg.source,
			});
			continue;
		}
		if (!hasDesktopUiResources(metadata.desktopUi)) continue;
		const id = desktopUiPluginId(scope, pkg.source);
		plugins.push({
			id,
			name: metadata.name || sourceName(pkg.source),
			...(metadata.version ? { version: metadata.version } : {}),
			...(metadata.description ? { description: metadata.description } : {}),
			scope,
			styles: metadata.desktopUi.styles.map((_path, index) => `/plugins/ui-assets/${id}/styles/${index}`),
			scripts: metadata.desktopUi.scripts.map((_path, index) => `/plugins/ui-assets/${id}/scripts/${index}`),
		});
	}
	plugins.sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
	return { plugins, diagnostics };
}

export function resolveDesktopUiPluginAsset(
	config: SecHeurConfig,
	pluginId: string,
	type: DesktopUiPluginAssetType,
	index: number,
): string | undefined {
	if (!/^[a-f0-9]{24}$/u.test(pluginId) || !DESKTOP_UI_ASSET_TYPES.includes(type)) return undefined;
	if (!Number.isSafeInteger(index) || index < 0) return undefined;
	const { settingsManager, packageManager } = createPackageManager(config);
	for (const pkg of packageManager.listConfiguredPackages()) {
		const scope = pkg.scope;
		if (desktopUiPluginId(scope, pkg.source) !== pluginId || !pkg.installedPath) continue;
		const rawEntry = configuredEntry(settingsManager, scope, pkg.source);
		if (!(typeof rawEntry === "string" || rawEntry?.autoload !== false)) return undefined;
		return readPackageMetadata(pkg.installedPath).desktopUi[type][index];
	}
	return undefined;
}

export async function installPiPlugin(
	config: SecHeurConfig,
	sourceValue: unknown,
	scopeValue: unknown,
): Promise<PiPluginSnapshot> {
	const source = parsePiPluginSource(sourceValue);
	const scope = parsePiPluginScope(scopeValue);
	const { settingsManager, packageManager } = createPackageManager(config);
	await packageManager.installAndPersist(source, { local: scope === "project" });
	await settingsManager.flush();
	return listPiPlugins(config);
}

export async function setPiPluginEnabled(
	config: SecHeurConfig,
	sourceValue: unknown,
	scopeValue: unknown,
	enabledValue: unknown,
): Promise<PiPluginSnapshot> {
	const source = parsePiPluginSource(sourceValue);
	const scope = parsePiPluginScope(scopeValue);
	if (typeof enabledValue !== "boolean") throw new Error("Plugin enabled must be a boolean");
	const { settingsManager } = createPackageManager(config);
	const entries = packageEntries(settingsManager, scope);
	const index = entries.findIndex((entry) => sourceOf(entry) === source);
	if (index < 0) throw new Error(`Configured Pi plugin was not found: ${source}`);
	const current = entries[index];
	if (enabledValue) {
		if (typeof current === "string") return listPiPlugins(config);
		const restored = { ...current };
		delete restored.autoload;
		entries[index] = Object.keys(restored).length === 1 ? restored.source : restored;
	} else {
		entries[index] =
			typeof current === "string" ? { source: current, autoload: false } : { ...current, autoload: false };
	}
	writePackageEntries(settingsManager, scope, entries);
	await settingsManager.flush();
	return listPiPlugins(config);
}

export async function updatePiPlugin(
	config: SecHeurConfig,
	sourceValue: unknown,
	scopeValue: unknown,
): Promise<PiPluginSnapshot> {
	const source = parsePiPluginSource(sourceValue);
	const scope = parsePiPluginScope(scopeValue);
	const { settingsManager, packageManager } = createPackageManager(config);
	if (!configuredEntry(settingsManager, scope, source)) {
		throw new Error(`Configured Pi plugin was not found: ${source}`);
	}
	await packageManager.update(source);
	await settingsManager.flush();
	return listPiPlugins(config);
}

export async function removePiPlugin(
	config: SecHeurConfig,
	sourceValue: unknown,
	scopeValue: unknown,
): Promise<PiPluginSnapshot> {
	const source = parsePiPluginSource(sourceValue);
	const scope = parsePiPluginScope(scopeValue);
	const { settingsManager, packageManager } = createPackageManager(config);
	const entries = packageEntries(settingsManager, scope);
	const index = entries.findIndex((entry) => sourceOf(entry) === source);
	if (index < 0) throw new Error(`Configured Pi plugin was not found: ${source}`);
	await packageManager.remove(source, { local: scope === "project" });
	entries.splice(index, 1);
	writePackageEntries(settingsManager, scope, entries);
	await settingsManager.flush();
	return listPiPlugins(config);
}
