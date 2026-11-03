import { useEffect, useState } from "react";
import type { BridgeClient, ExplorationGraph } from "./bridge/client.ts";

export function ExplorationGraphView({ client, sessionId }: { client: BridgeClient; sessionId: string }) {
	const [refresh, setRefresh] = useState(0);
	return (
		<section style={{ overflow: "auto", padding: 24 }} aria-label="Artex 探索图">
			<button type="button" onClick={() => setRefresh((value) => value + 1)}>
				刷新探索图
			</button>
			<GraphContents key={`${sessionId}:${refresh}`} client={client} sessionId={sessionId} />
		</section>
	);
}

function GraphContents({ client, sessionId }: { client: BridgeClient; sessionId: string }) {
	const [graph, setGraph] = useState<ExplorationGraph>();
	const [error, setError] = useState("");
	const [detail, setDetail] = useState("");
	useEffect(() => {
		let active = true;
		setGraph(undefined);
		setDetail("");
		setError("");
		void client.getExplorationGraph(sessionId).then(
			(result) => {
				if (active) setGraph(result.graph);
			},
			(reason) => {
				if (active) setError(String(reason));
			},
		);
		return () => {
			active = false;
		};
	}, [client, sessionId]);
	return (
		<div>
			{error ? <p role="alert">{error}</p> : null}
			{graph ? (
				<>
					<p>
						第 {graph.round} 轮 · {graph.nodes.length} 个可见节点 · {graph.foldedNodeCount} 个节点已折叠 · 版本{" "}
						{graph.version}
					</p>
					<details>
						<summary>待办</summary>
						<pre style={{ whiteSpace: "pre-wrap" }}>{graph.todo}</pre>
					</details>
					<svg
						role="img"
						aria-label="探索图的节点与关系，详情见下方列表"
						width="100%"
						viewBox={`0 0 1000 ${Math.max(120, graph.nodes.length * 52)}`}
					>
						<defs>
							<marker
								id="artex-arrow"
								viewBox="0 0 10 10"
								refX="10"
								refY="5"
								markerWidth="5"
								markerHeight="5"
								orient="auto"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" fill="#7b8ca0" />
							</marker>
						</defs>
						{graph.edges.map((edge, index) => {
							const source = graph.nodes.findIndex((node) => node.id === edge.source);
							const target = graph.nodes.findIndex((node) => node.id === edge.target);
							return source < 0 || target < 0 ? null : (
								<path
									key={`${index}-${edge.source}`}
									d={`M 120 ${source * 52 + 25} Q ${10 + (index % 8) * 12} ${(source + target) * 26 + 25} 120 ${target * 52 + 25}`}
									fill="none"
									stroke="#7b8ca0"
									markerEnd="url(#artex-arrow)"
								>
									<title>{`${edge.source} → ${edge.target} (${edge.relation})`}</title>
								</path>
							);
						})}
						{graph.nodes.map((node, index) => (
							<g key={node.id} transform={`translate(120 ${index * 52 + 8})`}>
								<rect width="860" height="38" rx="6" fill={node.state === "running" ? "#dcfce7" : "#e8edf5"} />
								<text
									x="8"
									y="24"
									fill="#172033"
									fontSize="14"
								>{`${node.kind} · ${node.state} · ${node.payload.slice(0, 65)}`}</text>
								<title>{node.id}</title>
							</g>
						))}
					</svg>
					{graph.nodes.map((node) => (
						<details key={node.id}>
							<summary>
								{node.kind} · {node.state} · {node.id}
							</summary>
							<pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(node, null, 2)}</pre>
						</details>
					))}
					<details>
						<summary>关系与资产锚点</summary>
						<pre style={{ whiteSpace: "pre-wrap" }}>
							{JSON.stringify(
								{ edges: graph.edges, assets: graph.assets, assetEdges: graph.assetEdges },
								null,
								2,
							)}
						</pre>
					</details>
					{graph.digests.map((digest) => (
						<details key={digest.id}>
							<summary>原节点：{digest.id}</summary>
							{digest.memberIds.map((id) => (
								<button
									key={id}
									type="button"
									onClick={() =>
										void client
											.getExplorationNode(sessionId, id)
											.then((result) => setDetail(JSON.stringify(result.node, null, 2)))
											.catch((reason) => setError(String(reason)))
									}
								>
									{id}
								</button>
							))}
						</details>
					))}
					{detail ? <pre style={{ whiteSpace: "pre-wrap" }}>{detail}</pre> : null}
				</>
			) : !error ? (
				<p>正在读取当前会话的探索图…</p>
			) : null}
		</div>
	);
}
