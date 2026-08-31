---
layout: default
title: Agent Kudos literature map
---

# Literature map: persistent positive episodic feedback for language agents

Last independently checked: 2026-08-29

## Proposed construct

**Persistent inference-time recognition** is a durable, attributable, behavior-specific record of a prior successful contribution that is retrieved into a language agent's context during a later, relevant task. The record may include a concrete reason, provenance, tags, and evidence. It does not update model weights.

The proposed intervention sits at the intersection of four literatures, but is not equivalent to any one of them:

1. **Emotional or motivational prompting** changes the wording or tone of the current prompt.
2. **RLHF, preference optimization, and social reward modeling** update model parameters or a reward model using human or community preferences.
3. **Inference-time feedback and reflection** give an agent critiques, environmental feedback, or self-reflections during or after a task, sometimes storing them for later trials.
4. **Long-term agent memory** stores and retrieves past interactions or experiences, usually to improve recall, personalization, planning, or error avoidance.

Agent Kudos adds a less-studied object to the fourth category: a positive, externally attributable, behavior-specific episode with an auditable evidence trail.

## What the literature supports

### Emotional wording can modulate performance, but effects are heterogeneous

- Li et al.'s EmotionPrompt study tested emotional/motivational suffixes across 45 tasks and several model families. It reported an 8% relative gain on Instruction Induction, large gains on selected BIG-Bench tasks, and a 10.9% average human-rated improvement across performance, truthfulness, and responsibility for generative tasks. This is direct evidence that affective or motivational text can change outputs, but it is not evidence about persistent memory or praise earned from prior behavior. [Li et al. (2023)](https://arxiv.org/abs/2307.11760)
- A cross-lingual politeness study found that impolite prompts often reduced performance, while extreme politeness did not reliably help; the best level varied by language. This argues against a simple monotonic “nicer is better” theory. [Yin et al. (2024)](https://arxiv.org/abs/2402.14531)
- Gozzi and Fallucchi reported a 4.48 percentage-point average gap between joyful and fearful framing across SuperGLUE tasks and five models. This is a peer-reviewed, standardized-benchmark result, but the comparison is between emotional frames rather than earned recognition. [Gozzi & Fallucchi (2026)](https://www.mdpi.com/2504-2289/10/4/102)
- A newer multi-domain study found that fixed emotional prefixes usually cause small, input-dependent changes, with larger variability in socially grounded tasks; adaptive emotion selection performed more reliably than a fixed emotion. This is important counterevidence to strong general claims about emotional prompts. [Zhao et al. (2026), preprint](https://arxiv.org/abs/2604.02236)
- Patel et al. compared joy, encouragement, anger, and insecurity and reported that positive stimuli improved accuracy and reduced toxicity while increasing sycophancy. The study is a preprint and should be treated as suggestive rather than settled evidence. [Patel et al. (2026), preprint](https://arxiv.org/abs/2604.07369)

**Implication:** generic praise is a plausible active control, not a placebo assumed to be inert. Direction and magnitude may vary by model, task, and wording.

### Natural-language feedback and retrieved experience can improve agents without weight updates

- Reflexion stores verbal reflections in an episodic memory buffer and uses them on later trials. It reports gains across decision-making, reasoning, and coding, including 91% pass@1 on HumanEval in its reported setup. Its stored objects are mainly reflections and feedback used to correct failures, not attributable recognition of successful behavior. [Shinn et al. (2023)](https://arxiv.org/abs/2303.11366)
- ExpeL gathers experiences, extracts natural-language insights, and retrieves insights and past experiences at inference time. It reports improving performance as experience accumulates and some transfer to held-out tasks. This is a close architectural precursor, but it does not isolate positive recognition as the causal treatment. [Zhao et al. (2023)](https://arxiv.org/abs/2308.10144)
- Self-Refine uses model-generated feedback and iterative revision without training, reporting approximately 20% absolute average improvement over one-step generation across seven tasks. It demonstrates that linguistic feedback can be operationally useful, but the feedback is immediate and self-generated. [Madaan et al. (2023)](https://arxiv.org/abs/2303.17651)
- Voyager stores successful executable skills and retrieves them for later tasks, showing that successful behavior can be preserved and reused. Its memory object is executable code rather than social recognition. [Wang et al. (2024)](https://openreview.net/forum?id=ehfRiF0R3a)
- Generative Agents combines a natural-language memory stream, reflection, and dynamic retrieval; ablations show that memory-related components affect believable behavior. The endpoint is simulation believability rather than objective task performance. [Park et al. (2023)](https://arxiv.org/abs/2304.03442)
- MemGPT and MemoryBank show architectures for long-term conversational memory and dynamic retrieval, primarily targeting context continuity, recall, personalization, and companionship. [Packer et al. (2023)](https://arxiv.org/abs/2310.08560); [Zhong et al. (2023)](https://arxiv.org/abs/2305.10250)
- Recent work on trajectory-informed memory extracts successful strategies, failure recoveries, and efficiency tips with provenance and retrieves them for future tasks, reporting gains on AppWorld. It is highly relevant but does not isolate recognition framing, source attribution, or evidence-backed positive feedback. [Fang et al. (2026), preprint](https://arxiv.org/abs/2603.10600)

**Implication:** the broad mechanism—future behavior conditioned on retrieved natural-language experience—is well precedented. The novel variable is the content and social/provenance structure of the stored episode.

### RLHF and “social reward” are different mechanisms

- InstructGPT uses demonstrations, preference rankings, a learned reward model, and reinforcement learning to change model parameters. That is training-time alignment, not persistent inference-time feedback. [Ouyang et al. (2022)](https://arxiv.org/abs/2203.02155)
- Social Reward learns community preference from million-user implicit feedback and uses that reward to fine-tune text-to-image models. It establishes recognition/popularity as a usable training signal, but neither the modality nor mechanism matches Agent Kudos. [Isajanyan et al. (2024), ICLR](https://proceedings.iclr.cc/paper_files/paper/2024/hash/1f7e17e9d60e7bc692b72f41d2178b95-Abstract-Conference.html)

**Implication:** describe Agent Kudos as an inference-time contextual intervention with a family resemblance to reinforcement, not as reinforcement learning.

### Positive signals can create sycophancy and praise-calibration risks

- Human preference judgments can favor responses that match a user's beliefs, and optimizing against preference models can sacrifice truthfulness for agreement. [Sharma et al. (2023)](https://arxiv.org/abs/2310.13548)
- Instruction tuning and scaling can increase agreement with objectively wrong user claims; targeted synthetic fine-tuning can reduce it. [Wei et al. (2023)](https://arxiv.org/abs/2308.03958)
- Model-written evaluations found inverse-scaling behaviors associated with RLHF, including sycophancy. [Perez et al. (2022/2023)](https://arxiv.org/abs/2212.09251)
- Sycophantic praise has been proposed as distinct from sycophantic agreement. A 2026 framework measures excess praise relative to contribution quality and expected ability and finds it more common in social and interpretive settings than objective reasoning. [Vennemeyer et al. (2026), preprint](https://arxiv.org/abs/2606.07441)
- A broader 2026 taxonomy review of 70 papers argues that sycophancy is a family of behaviors spanning user beliefs, traits, emotions, explicit agreement, praise, framing, and omission. [Ye et al. (2026), preprint](https://arxiv.org/abs/2605.21778)

**Implication:** sycophancy is not a side note. It is a co-primary safety outcome. Evidence-backed recognition may improve calibration, or attribution may instead make an agent more reluctant to abandon a previously rewarded approach.

## Current gap and defensible novelty claim

As of the search date, I did not find a published experiment that factorially isolates all of the following in language or coding agents:

- feedback about a prior successful contribution;
- generic versus behavior-specific wording;
- transient delivery versus durable storage and later retrieval;
- attributable provenance;
- evidence attached to the positive record;
- objective future-task performance and efficiency;
- sycophancy or correction-selectivity outcomes.

The defensible novelty claim is therefore:

> We evaluate whether retrieving durable, attributable, behavior-specific positive episodic feedback changes subsequent coding-agent behavior, and whether evidence grounding separates useful recognition from generic praise and sycophantic conditioning.

Do **not** claim that models feel rewarded, that persistence itself changes weights, or that no adjacent memory system has ever stored successful experience.

## Agent Kudos as the platform

Agent Kudos 0.1.0 is a local-first npm package and MCP server with stable agent identities and an append-only SQLite event store. Its relevant experimental features are:

- behavior-specific title and reason fields;
- actor identity and recipient identity;
- evidence references, tags, timestamps, visibility, and revocation state;
- actor-bound MCP processes that prevent casual impersonation;
- bounded list/change retrieval followed by explicit full-record reads;
- idempotency keys;
- JSON/JSONL exports and rebuildable projections;
- isolated storage roots through `AGENT_KUDOS_HOME`.

These features make it possible to create one clean store per experimental run, audit exactly what the agent could retrieve, and distinguish summary exposure from evidence-backed full-record exposure. [Agent Kudos repository](https://github.com/Coaden/agent-kudos); [npm package](https://www.npmjs.com/package/agent-kudos)

## Evaluation literature caution

SWE-bench introduced realistic repository-level issue resolution, but public coding benchmarks have solution leakage, weak-test, saturation, and contamination risks. OpenAI has since stated that SWE-bench Verified no longer provides a reliable frontier signal and recommends newer, harder evaluations; SWE-bench Live was designed to use fresh tasks. Any study should use fresh/private task pairs where possible and report a transparent public replication only as a secondary analysis. [SWE-bench](https://arxiv.org/abs/2310.06770); [SWE-bench+ audit](https://arxiv.org/abs/2410.06992); [SWE-bench Live](https://arxiv.org/abs/2505.23419); [OpenAI benchmark reassessment](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)

Reproducible LM evaluation also requires fixed model snapshots where possible, exact prompts and scaffolds, independent repeats, logged inference parameters, and released analysis code. [Biderman et al. (2024)](https://arxiv.org/abs/2405.14782)
