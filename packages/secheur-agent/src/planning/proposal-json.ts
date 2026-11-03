export class ProposalOutputError extends Error {
	readonly modelOutput?: { text: string; model: string; provider: string };
	constructor(message: string, modelOutput?: { text: string; model: string; provider: string }) {
		super(message);
		this.name = "ProposalOutputError";
		this.modelOutput = modelOutput;
	}
}

/** Accept one complete JSON document, optionally wrapped in one Markdown fence.
 * Never repair missing braces, select one of several proposals, or alter values. */
export function parseProposalJson(text: string): unknown {
	const trimmed = text.trim();
	const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	return JSON.parse(fence ? fence[1].trim() : trimmed);
}
