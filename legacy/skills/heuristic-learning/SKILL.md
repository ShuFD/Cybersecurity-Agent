---
name: heuristic-learning
description: Use when improving programs, agents, policies, workflows, research plans, or decision systems through Heuristic Learning, State Engineering, explicit feedback loops, or decision-layer reasoning. Trigger on learning from failures, refining heuristics, designing state representations or world models, separating decision from execution, preserving old capabilities, maintaining tests/logs/replays/human feedback, avoiding catastrophic forgetting, and turning outcomes into reusable rules or memory.
---

# Heuristic Learning

## Overview

Use Heuristic Learning (HL) when the object being improved is a maintained system: code, rules, state readers, tests, logs, memories, experiment records, or update procedures. Treat the coding agent as the update mechanism that reads feedback and edits the system directly.

HL is not "add one more if statement." A healthy Heuristic System (HS) connects policy, state representation, feedback channels, memory, tests/replays, and future update paths.

Source concept: Jiayi Weng, "Learning Beyond Gradients", https://trinkle23897.github.io/learning-beyond-gradients/

State Engineering concept: Spice treats agent systems as a decision layer with perception, state modeling, simulation, decision, execution, and reflection. Use that idea here without requiring the Spice runtime: improve the state model before patching the policy.

## First Response

When this skill triggers:

1. Identify the system to improve, not only the immediate output.
2. Name the feedback sources available now: tests, rewards, logs, failures, traces, videos, benchmark scores, user feedback, documents, or examples.
3. Separate decision from execution: what should be decided, what should be executed, and where approval or verification belongs.
4. Ask for the missing feedback or state artifact only if progress would otherwise be speculative.
5. Propose the smallest loop that can absorb feedback, update the state model or policy, and record what changed.

## Workflow

### 1. Define The Heuristic System

Describe these pieces explicitly:

- Goal: what capability, score, reliability property, or decision quality should improve.
- State representation: what variables, detectors, summaries, traces, or documents make the situation readable.
- Actions: what the system can change or choose.
- Feedback: what signals say a change helped or hurt.
- Memory: where trials, failures, rationales, examples, diffs, and old capabilities are preserved.
- Update mechanism: what the coding agent should edit next.

If any piece is absent, say so and either create a lightweight substitute or narrow the task.

### 2. Engineer The State Before The Policy

Before changing actions, rules, prompts, or plans, inspect whether the system can see the right state:

- Raw observation: what direct inputs, files, logs, traces, user messages, URLs, screenshots, metrics, or events are available.
- Derived state: what structured facts, summaries, labels, world-model assumptions, or task variables are inferred from the raw observation.
- State scope: distinguish environment state, agent/session state, task state, decision state, feedback state, and long-term memory.
- Evidence links: keep source pointers so important state claims can be audited.
- Uncertainty: mark unknown, stale, inferred, conflicting, or low-confidence state instead of flattening it into facts.
- History: preserve decision cards, selected/rejected options, outcomes, replays, and memory summaries when they affect future decisions.
- Validation: define how to prove the state reader is correct before optimizing the policy that consumes it.

Prefer state updates when failures come from missing context, stale memory, bad summaries, hidden assumptions, or unobservable decision criteria.

Use policy updates when the state is already reliable and the decision rule is wrong.

### 3. Turn Feedback Into Candidate Updates

Generate multiple candidate changes before committing to one:

- State-reader update: make the system observe the important condition more accurately.
- State-boundary update: separate volatile context, persistent memory, decision guidance, execution intent, and outcome records.
- Policy/rule update: change the decision logic.
- Test/replay update: preserve a new old-capability or failure case.
- Memory update: record a failed direction, assumption, or result.
- Interface update: stabilize boundaries so later edits do not require global reasoning.
- Decision-layer update: compare options before execution and make rejected tradeoffs inspectable.
- Compression update: replace accumulated patches with a simpler representation.

Prefer changes that improve the feedback loop itself when the current evidence is unclear.

### 4. Preserve Old Capabilities

Before making a change that could break existing behavior, convert old capabilities into explicit artifacts:

- Regression tests
- Fixed-seed replays
- Golden traces or snapshots
- Failure videos or logs
- Version diffs with rationale
- Written records of failed hypotheses

Do not trust implicit memory when the capability matters.

### 5. Run A Closed Loop

Use this loop:

1. Perceive a failure, reward, log anomaly, benchmark gap, source update, execution outcome, or user critique.
2. Update the state model with source-backed facts, uncertainty, and relevant history.
3. Simulate or compare candidate next actions before executing.
4. Localize which part of the HS caused the issue: perception, state, policy, feedback, memory, interface, decision boundary, or update procedure.
5. Edit the smallest useful part of the system.
6. Rerun the feedback source.
7. Record the result, sources, selected option, rejected tradeoffs, and reason.
8. Simplify or refactor when local patches start coupling together.

When the task is conceptual rather than code-based, map the same loop to hypotheses, notes, evidence, experiments, and decisions.

### 6. Control Coupling Complexity

Judge complexity by maintainability, not lines of code. Watch for:

- Rules whose interactions cannot be predicted locally
- State and policy coupled so tightly that changing observations also changes decisions
- Decision and execution coupled so tightly that options are not compared before action
- Hidden state or irreproducible feedback
- Tests that only validate the latest patch
- Memories that repeatedly steer the agent into bad directions
- Interfaces that force unrelated modules to change together
- Growth without compression

Reduce coupling by adding module boundaries, stable interfaces, observability, reproducible cases, rollback paths, and summaries of why choices were made.

## Decision Heuristics

Use these prompts while reasoning:

- What exactly is being updated: model weights, code, memory, tests, prompts, data, or process?
- Is the current failure caused by bad perception, bad state, bad policy, bad feedback, bad memory, or bad system boundaries?
- Is the policy wrong, or is it acting on stale, lossy, unvalidated, or mixed-scope state?
- Which state belongs in raw observation, derived state, session memory, decision guidance, execution intent, or outcome history?
- Can each important state claim point back to a source?
- Should the system compare options before execution and preserve why rejected options lost?
- What old behavior needs to become a regression case before changing anything?
- What local patch would work now but make the system harder to maintain later?
- What simpler representation could absorb several patches?
- What evidence would disprove the current direction quickly?
- Is a neural component better suited for perception/generalization, while HL owns rules, tests, memory, recovery, and fast online adaptation?

## Output Shape

For non-trivial tasks, structure the response as:

1. Current HS: concise map of goal, state, action, feedback, memory, and update mechanism.
2. State model: raw observation, derived state, uncertainty, source links, memory, and boundaries.
3. Feedback diagnosis: what the available signals imply and what remains uncertain.
4. Candidate updates: 2-3 options with tradeoffs.
5. Chosen update: the smallest defensible next step.
6. Preservation: tests, replays, decision records, notes, or artifacts that protect old capability.
7. Compression check: whether the system needs simplification now or can safely grow one more step.

For implementation work, actually make the chosen update and verify it with the strongest available feedback source.

## Failure Modes

Avoid these patterns:

- Treating HL as a bag of isolated rules instead of a maintained system.
- Optimizing the visible score while ignoring reproducibility and old capabilities.
- Patching policy when the real defect is missing, stale, or unvalidated state.
- Mixing raw observations, derived summaries, durable memory, decision guidance, execution intent, and outcomes in one opaque blob.
- Letting decision and execution collapse into one unreviewable action.
- Adding rules without improving state representation or feedback.
- Letting memories accumulate without pruning failed or obsolete directions.
- Mistaking a single successful seed, example, or benchmark run for robust learning.
- Refusing neural-network components where code heuristics are the wrong representation.
