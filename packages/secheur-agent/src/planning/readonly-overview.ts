/** Compact pointers for host roles; original records remain available by ID. */
export function planningRecordOverview(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
	if (Array.isArray(value)) return value.slice(-12).map((item) => planningRecordOverview(item, depth + 1));
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value);
	if (depth > 3) return { fields: entries.map(([key]) => key), detailAvailable: true };
	return Object.fromEntries(entries.slice(0, 16).map(([key, item]) => [key, planningRecordOverview(item, depth + 1)]));
}

/** Bound the initial overview structurally; never leave a sliced JSON object for the model to reconstruct. */
export function planningContextOverview(context: Record<string, unknown>): Record<string, unknown> {
	const hasRecent = Object.hasOwn(context, "recent");
	const sectionLimit = Math.max(
		512,
		Math.floor((hasRecent ? 8192 : 16384) / Math.max(1, Object.keys(context).length - (hasRecent ? 1 : 0))),
	);
	return Object.fromEntries(
		Object.entries(context).map(([key, value]) => {
			const limit = key === "recent" ? 8192 : sectionLimit;
			if (key === "recent" && value && typeof value === "object" && !Array.isArray(value)) {
				const entries = Object.entries(value);
				return [
					key,
					Object.fromEntries(
						entries.map(([worker, rounds]) => {
							const records: unknown[] = [];
							if (Array.isArray(rounds))
								for (const round of rounds.slice(-10).reverse()) {
									if (JSON.stringify([...records, round]).length > limit / Math.max(1, entries.length) - 128)
										break;
									records.unshift(round);
								}
							return [
								worker,
								{ totalRounds: Array.isArray(rounds) ? rounds.length : 0, records, detailAvailable: true },
							];
						}),
					),
				];
			}
			const overview = planningRecordOverview(value);
			if (JSON.stringify(overview ?? null).length <= limit) return [key, overview];
			if (Array.isArray(value)) {
				const records: unknown[] = [];
				for (const item of value.slice(-12)) {
					const record = planningRecordOverview(item);
					if (JSON.stringify([...records, record]).length > limit - 128) break;
					records.push(record);
				}
				return [key, { totalRecords: value.length, records, detailAvailable: true }];
			}
			return [key, { fields: value && typeof value === "object" ? Object.keys(value) : [], detailAvailable: true }];
		}),
	);
}

/** Same preview sizes as BreachWeave's observer-loop, with evidence IDs kept intact. */
export function observerTurnOverview(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const message =
		record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : {};
	const content = Array.isArray(message.content) ? message.content : [];
	return {
		...Object.fromEntries(
			Object.entries(record).filter(([key]) => ["taskId", "leaseId", "intentId", "at"].includes(key)),
		),
		assistantSummary: content
			.flatMap((part) =>
				part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : [],
			)
			.join("\n")
			.slice(0, 220),
		tools: content
			.flatMap((part) => {
				if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall") return [];
				return [
					{
						name: "name" in part ? part.name : "unknown",
						argsPreview: JSON.stringify(("arguments" in part ? part.arguments : null) ?? null).slice(0, 160),
					},
				];
			})
			.slice(0, 6),
		pendingTools: planningRecordOverview(record.pendingTools),
		evidenceRefs: planningRecordOverview(record.sharedEvidence),
	};
}
