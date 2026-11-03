import { type Static, Type } from "typebox";

export const repoAuditScanSchema = Type.Object(
	{
		repoPath: Type.String({
			minLength: 1,
			description: "Repository directory to analyze. Relative paths are resolved from the Pi tool context cwd.",
		}),
		language: Type.Union([Type.Literal("Cpp"), Type.Literal("Java"), Type.Literal("Python"), Type.Literal("Go")], {
			description: "Source language. Use Cpp for C and C++ repositories.",
		}),
		bugType: Type.Union([Type.Literal("MLK"), Type.Literal("NPD"), Type.Literal("UAF")], {
			description: "Supported data-flow bug class. The Adapter validates the language/bug-type combination.",
		}),
	},
	{ additionalProperties: false },
);

export type RepoAuditScanParams = Static<typeof repoAuditScanSchema>;
