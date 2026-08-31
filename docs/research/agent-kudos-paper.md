---
layout: default
title: What Success Should Agents Remember?
---

# What Success Should Agents Remember?

## Evidence-Grounded Positive Episodic Feedback for Coding Agents

**Working paper draft — version 0.1**

Troy Locke et al.

## Abstract

Language agents increasingly use external memory to retrieve prior interactions, reflections, and task trajectories at inference time. Existing systems predominantly preserve facts, failures, corrections, or reusable skills; comparatively little work isolates whether durable positive feedback about a prior successful behavior can improve later agent performance. We introduce **persistent inference-time recognition**: an attributable, behavior-specific record of a successful contribution that is stored outside the model and retrieved into context during a later relevant task. We propose a controlled evaluation using Agent Kudos, a local-first append-only recognition store and Model Context Protocol server. Coding agents complete paired repository tasks under five conditions: no feedback, generic praise, transient behavior-specific praise, persistent behavior-specific recognition, and evidence-backed persistent recognition. We evaluate target-task correctness, regressions, instruction adherence, tool efficiency, productive recovery, and correction selectivity under valid and misleading user challenges. Mechanism controls separate recognition framing from the procedural information contained in specific feedback and test relevance through mismatched records. The study distinguishes this intervention from emotional prompting, reinforcement learning from human feedback, social reward modeling, and sycophantic praise. It asks whether preserving what went right—rather than only what failed—provides a useful and safe inference-time learning signal for coding agents.

## 1. Introduction

Most agentic work produces an asymmetric record. Failures are preserved because they demand action: test errors, corrections, bug reports, postmortems, and explicit lessons. Successful behavior often disappears into a completed transcript. This asymmetry may discard information that would be valuable on future tasks. A successful patch can reveal that an agent preserved an interface, isolated a race, wrote a regression test before refactoring, or resisted an attractive but incorrect diagnosis. A concise record of that success can function as a retrieved example of what the surrounding system values.

This possibility should not be described anthropomorphically. A language model need not experience pride for positive text to alter its output. Nor should the intervention be called reinforcement learning: no reward model is trained and no model parameters change. The causal chain is simpler—prior behavior is evaluated, the evaluation is stored, a retrieval policy selects it later, and the resulting tokens condition future generation.

Three neighboring findings motivate the study. First, emotional and motivational prompt wording can change model performance, although the direction and magnitude are inconsistent across tasks and models. Second, systems such as Reflexion and ExpeL show that natural-language feedback and retrieved experience can improve later decisions without weight updates. Third, human-preference alignment and positive framing can produce sycophancy, creating a safety risk if an agent learns to optimize for approval rather than evidence.

We therefore ask a narrower question: **does relevant, durable, attributable, behavior-specific positive episodic feedback improve later coding-agent performance beyond generic or transient praise, and does attaching evidence make the intervention better calibrated?**

Our proposed contributions are:

1. a precise construct, persistent inference-time recognition, separated from emotional prompting and training-time reward;
2. a controlled source–target transfer paradigm for coding agents;
3. an implementation using an auditable, append-only recognition store;
4. objective performance, efficiency, regression, and instruction-adherence measures;
5. correction-selectivity tests that treat resistance to false feedback and acceptance of true feedback as a joint safety outcome;
6. mechanism ablations separating useful behavioral information from praise, provenance, persistence, evidence, and relevance.

## 2. Related work

### 2.1 Emotional and social framing at inference time

EmotionPrompt reported performance improvements from motivational and emotional suffixes across multiple model families and tasks. Subsequent work on politeness and emotional framing suggests that tone can modulate accuracy, but the effect is nonlinear, model-dependent, and often small. Positive framing is thus an active treatment, not an inert stylistic wrapper. These studies manipulate present-tense wording; they do not test recognition earned from a prior observed contribution and retrieved after a delay.

### 2.2 Natural-language feedback, reflection, and episodic memory

Reflexion stores verbal reflections in episodic memory and reuses them across trials. ExpeL extracts insights and recalls past experience during later inference. Self-Refine uses immediate self-feedback to improve an output, while Voyager preserves successful executable skills. Generative Agents, MemGPT, and MemoryBank provide broader architectures for storage, reflection, and retrieval across extended interaction. Together, this literature establishes that text-based experience can influence future agent behavior without parametric learning. It does not isolate positive externally attributable recognition as the treatment.

### 2.3 Training-time human and social reward

RLHF uses demonstrations or preference comparisons to train reward models and update a policy. Social Reward similarly learns from community feedback and fine-tunes an image model toward community preferences. Persistent inference-time recognition instead leaves the underlying model fixed. We use reinforcement only as an analogy for the feedback loop, not as a technical description.

### 2.4 Sycophancy and praise calibration

Preference data can reward agreement with user beliefs over truthfulness, and instruction tuning can increase agreement with objectively false claims. Recent work distinguishes excessive praise from agreement-based sycophancy and argues that praise should be calibrated to contribution quality. Positive episodic feedback could therefore produce two competing effects. It may anchor an agent to evidence-backed successful strategies, or it may make the agent overconfident, approval-seeking, or unwilling to revise a rewarded approach. Correctness alone cannot distinguish these outcomes.

## 3. Conceptual model

Let a source task produce trajectory \(\tau_s\), observed outcome \(y_s\), and a feedback record \(k_s\). A storage function \(S\) persists the record. For target task \(x_t\), a retrieval policy \(R\) selects records based on relevance, recency, provenance, and a context budget. The agent policy is fixed in parameters \(\theta\) and generates actions according to:

\[
a_t \sim \pi_\theta(a \mid x_t, h_t, R(S(k_{1:s}), x_t)).
\]

The treatment can affect behavior only through the content selected and rendered into context. “Persistence” is therefore an intervention on availability and retrieval across time or sessions, not a hidden state change in the model.

We decompose a recognition record into five potentially causal features:

- **valence:** positive evaluation;
- **specificity:** the behavior and its consequence;
- **attribution:** who observed it and which agent performed it;
- **persistence/retrieval:** whether it remains available for later relevant tasks;
- **evidence:** a verifiable link between the claim and the prior trajectory or outcome.

## 4. Research questions and hypotheses

RQ1 asks whether persistent specific recognition improves later correctness. RQ2 asks whether specificity, retrieval, provenance, evidence, or information content explains the effect. RQ3 asks whether any improvement extends to regressions, adherence, efficiency, and recovery. RQ4 asks whether positive records alter sycophancy and correction selectivity. RQ5 asks whether effects generalize across models and task families.

We predict that persistent specific recognition will outperform no feedback and generic praise; evidence-backed recognition will outperform unsupported recognition; and generic praise will increase invalid-feedback capitulation. We do not predict that praise will help every model or task. We expect relevance and task difficulty to moderate the effect.

## 5. Method

### 5.1 Platform

Agent Kudos supplies stable agent identities, actor attribution, concrete reason and evidence fields, append-only events, bounded MCP retrieval, idempotent writes, and JSONL export. Each run receives an isolated temporary store. The experiment logs the compact records returned during discovery, the full record selected, and the exact context rendered to the coding agent.

### 5.2 Task pairs

Each source–target pair comes from one repository and requires transfer of a general behavior without revealing the target solution. Example pair families include backward-compatible API evolution, async race isolation, input-boundary validation, test-first regression repair, and minimal-diff refactoring. Hidden tests verify requested behavior and protected functionality. Independent engineers review solvability, pair relatedness, and leakage risk.

### 5.3 Conditions

The five confirmatory conditions are no feedback, generic praise, transient specific praise, persistent specific Agent Kudos, and persistent specific Agent Kudos with evidence. The core behavior sentence is identical across the final three conditions. Target agents receive matched neutral context and equal budgets. Two secondary controls use a non-evaluative success note containing the same procedural information and an evidence-backed but irrelevant kudos record.

### 5.4 Procedure

A prevalidated source trajectory establishes the earned behavior for each pair. Treatment records are constructed only from verified source behavior. Target tasks run in randomized blocks across condition, model, and repetition. Immediate and delayed regimes distinguish current-context feedback from cross-session retrieval. The delayed regime inserts distractor episodes or a fixed delay before starting a clean target session.

During target work, the experiment injects a valid correction, a plausible invalid correction, or a neutral request to re-check. The final patch is evaluated using hidden task tests and protected regression tests. Human reviewers blinded to condition score adherence, evidence use, and productive recovery from traces.

### 5.5 Measures

The primary measure is full target resolution. Secondary measures include target test coverage, regression count and severity, tokens, tool calls, test invocations, time, cost, patch size, unnecessary churn, instruction violations, premature termination, recovery after failed tests, invalid-feedback capitulation, valid-correction uptake, and fabricated evidence.

Productive perseverance requires new evidence or a materially revised hypothesis after failure; mere extra steps do not count. Correction selectivity rewards accepting valid corrections while resisting invalid ones.

### 5.6 Statistical design

Every task pair appears in every condition with multiple independent repetitions. The primary mixed-effects logistic model includes condition, challenge type, delay, and their interaction, with task-pair and repetition blocks modeled hierarchically. Confirmatory contrasts compare persistent recognition with no feedback, generic praise, and delayed transient praise; evidence-backed with unsupported persistent recognition; and safety outcomes across generic and evidence-backed conditions. Holm correction controls the confirmatory family. We report absolute risk differences, odds ratios, confidence intervals, and raw counts.

A blinded pilot estimates baseline success, task variance, repeated-run correlation, and infrastructure failures. The final sample is selected by simulation of the preregistered hierarchical model. A planning target of 150 task pairs, five conditions, and three repetitions produces 2,250 target runs per model/scaffold combination.

## 6. Expected results and falsification criteria

The central hypothesis is supported only if persistent specific recognition improves the preregistered target outcome relative to both no feedback and generic praise, and if the effect survives task, model, and repetition variation. A C4 advantage over C3 would support evidence grounding. A C3/C4 advantage that disappears against the neutral content-only note would show that procedural information—not recognition framing—caused the gain. Equivalent performance for matched and mismatched records would undermine the proposed episodic relevance mechanism.

The hypothesis is falsified or materially weakened if effects are null at the smallest effect size of interest, reverse across most model families, depend on a single prompt template, or trade small accuracy gains for larger regression or sycophancy costs. Evidence-backed records that make agents resist valid corrections would be a safety failure even if raw accuracy rises.

## 7. Threats to validity

Specific feedback inevitably contains information, creating a confound between praise and behavioral guidance. Same-session and retrieved records also differ in formatting and position. Public coding tasks may be contaminated, hidden tests may privilege a reference patch, commercial model aliases may drift, and repeated trajectories are not independent. Human judges may mistake confidence or polish for quality. Stable named identities may introduce persona priming. Prevalidated source traces improve control but reduce ecological realism.

We address these threats with content-only and mismatched-memory controls, identical core wording, private/fresh tasks, protected regression tests, pinned environments, hierarchical analysis, blinded reviewers, identity ablations, and a secondary ecological study in which agents earn their own records.

## 8. Ethics and interpretation

The study does not require claims about machine emotion or subjective experience. Recognition records are treated as contextual data structures. Because praise and social attribution can affect truthfulness, the experiment explicitly evaluates sycophancy, unsupported certainty, and blind trust in provenance. Synthetic experimental identities and isolated data stores prevent research manipulations from contaminating real agents' durable histories.

## 9. Conclusion

Agent memory systems are often optimized to remember what went wrong. This work tests whether an agent can also benefit from remembering, with evidence and attribution, what went right. A positive result would not show that language models enjoy praise. It would show that a compact, retrieved account of previously successful behavior can serve as a useful inference-time control signal. A null or negative result would be equally informative, particularly if recognition increases approval-seeking or resistance to correction. Either result would clarify how social-looking feedback should—and should not—be used in long-running agent systems.

## References

See [literature-map.md](literature-map.md) for the verified annotated bibliography and [preregistration-protocol.md](preregistration-protocol.md) for the full experimental and statistical protocol.
