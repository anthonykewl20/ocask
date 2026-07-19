# Verdict-Contract Abstention & Structured-Output Extraction Failures in LLM Code Review

*Research note. Question: when an LLM code-reviewer must emit a structured verdict (JSON with a `verdict` field, or a `VERDICT: BLOCKED/WARNING/APPROVED` line), what causes a high rate of "unusable reply" — the model reviews but the harness cannot extract a usable verdict — and what are the proven mitigations?*

All claims below trace to primary sources (vendor API docs, arXiv papers, first-party GitHub issues, library docs). Secondary blog posts are avoided except where they quote a primary artifact verbatim.

---

## Executive summary (highest-confidence takeaways)

1. **Forcing a strict JSON/verdict contract measurably degrades the *quality* of the answer, not just its format.** The "Let Me Speak Freely?" study (EMNLP 2024 Industry) shows JSON-mode constrained decoding cuts reasoning accuracy hard — e.g. Claude-3-Haiku on GSM8K fell from **86.5% → 23.4%** under schema-constrained JSON, recovering to **~87%** when the schema constraint was relaxed. A code verdict is a reasoning task, so the contract itself can cause both wrong verdicts and unusable ones. [1]
2. **DeepSeek's own docs and issue tracker document exactly the "model reviewed but returned nothing usable" failure.** JSON mode "may occasionally return empty content"; function calling is "unstable, which may result in looped calls or empty responses"; and the reasoner (R1) has no native JSON/tool support. These are first-party, acknowledged caveats — not user error. [2][3][4][5]
3. **Adding scaffolding (audit frameworks, multi-lens personas, long rubrics) raises instruction count and degrades adherence.** IFScale shows even frontier models drop to ~68% adherence at high instruction density, with reasoning models showing threshold-collapse; "lost in the middle" compounds this. More instructions → more dropped ones, and the verdict line is often what gets dropped. [6][7][8]
4. **The proven fix is to decouple reasoning from formatting: free-form review first, then a cheap/constrained extraction step ("NL-to-Format" / two-step).** This preserves reasoning while guaranteeing parseable output. Tolerant/best-effort parsing plus a single re-ask-with-error repair loop (the Instructor pattern) closes most residual failures. [1][9]
5. **Multi-model consensus panels add little and can be net-negative for a detect/judge task.** "Nine Judges, Two Effective Votes" finds panel judges share correlated errors, so nine models behave like ~two independent votes — you pay 9× to buy diversity you don't get, and each extra model is another chance to emit an unparseable verdict. [10]

---

## 1. Why strict JSON / a fixed verdict contract raises failure and refusal rates

**DeepSeek JSON Output mode (official docs).** To use JSON mode you must set `response_format={'type':'json_object'}` **and** include the literal word "json" in the system/user prompt with an example — omit it and the call errors rather than degrading gracefully. The docs carry two explicit caveats: *"When using the JSON Output feature, the API may occasionally return empty content. We are actively working on optimizing this issue."* and *"Set the `max_tokens` parameter reasonably to prevent the JSON string from being truncated midway."* Empty content and mid-object truncation are precisely the "model reviewed, harness got nothing usable" mode. [2]

**DeepSeek function calling (official docs).** The docs state the Function Calling capability *"is unstable, which may result in looped calls or empty responses."* First-party GitHub issues corroborate: DeepSeek-V3/V4 *"intermittently returns completely empty responses (content='', reasoning_content='', completion_tokens=0) when tool/function call results are fed back"* — returning in 1–2s vs. the normal 15–70s, i.e. it skips inference entirely. [3][4]

**Reasoning models + structured output.** DeepSeek-R1 (the reasoner) does **not** natively support tool calling / structured outputs; teams route through third-party grammar frameworks or a second summarization model. So the "review with a strong reasoner AND emit strict JSON in one call" pattern is unsupported on exactly the model class you'd want for hard review. [5]

**The deeper cause — format constraints hurt reasoning.** "Let Me Speak Freely?" (arXiv 2408.02442 / EMNLP 2024 Industry) is the load-bearing primary source. Constrained-decoding JSON mode dropped GSM8K accuracy: GPT-3.5-Turbo 76.6%→49.3%, Claude-3-Haiku 86.5%→23.4%, LLaMA-3-8B 74.7%→48.9%; Last-Letter concatenation fell similarly (LLaMA-3-8B 70.1%→28.0%). Relaxing the *schema* (keep "answer in JSON", drop the rigid key/enum grammar) restored Haiku to ~87%. Takeaway: the tighter the verdict contract (fixed enum, required keys), the more you tax the model's reasoning and the more often it either refuses the format or emits something off-contract. [1]

---

## 2. Does adding scaffolding (audit frameworks, multi-lens/persona prompts, consensus panels) make it worse?

**Yes — instruction density predicts adherence loss.** IFScale (arXiv 2507.11538, "How Many Instructions Can LLMs Follow at Once?") tested 20 models across 7 providers with up to 500 simultaneous instructions. Even the best frontier models reach only **~68% adherence at 500 instructions**, and models exhibit three decay curves — threshold collapse (reasoning models: o3, gemini-2.5-pro), linear decay (gpt-4.1, claude-sonnet-4), and exponential decay (gpt-4o, llama-4-scout). Every extra lens/persona/rubric bullet is another instruction competing for the same budget, and the single "emit VERDICT:" instruction is easily the one dropped. [6]

**"Lost in the middle" compounds it.** The classic finding (Liu et al., reflected in the enterprise "Instruction Gap" study arXiv 2601.03269) is that models weight information at the beginning and end of a long prompt and under-use the middle; a verdict-format instruction buried mid-prompt inside a large audit framework is at maximal risk of being ignored, and models "may encode instruction information but fail to leverage it effectively during generation." [7][8]

**Consensus panels multiply the failure surface.** Each additional model in a panel is an independent chance to (a) refuse, (b) emit malformed JSON, or (c) truncate — so an N-model panel has ~N× the per-call unusable-reply exposure before any aggregation logic even runs. Combined with §4's correlated-error finding, the panel buys little signal for a lot of extra parse-failure risk. *(Direct arXiv measurements isolate panel value and per-call format failure separately; the multiplicative-exposure point is an inference from those two, not a single measured number — flagged as lower-confidence.)*

---

## 3. Proven mitigations (with tradeoffs)

**A. Two-step: free-form review THEN cheap extraction (strongest, best-evidenced).** "Let Me Speak Freely?" recommends **NL-to-Format**: let the model reason/review in prose, then convert to the required schema in a separate, cheaper step. This preserves reasoning accuracy while still yielding structured output; the paper notes the conversion step "occasionally introduces generation errors" but otherwise tracks unrestricted performance. This maps cleanly onto: (1) reviewer emits a free-form review, (2) a cheap model or regex/parser extracts `verdict`. [1]

**B. Tolerant / best-effort parsing + one repair re-ask.** Instructor's documented pattern: on a Pydantic/JSON-decode failure it *"automatically constructs a new prompt that includes the original messages, the failed response, and the validation error text"* and re-asks, bounded by `max_retries`. A tolerant first pass (accept a `VERDICT:` line, a fenced code block, or a bare object; case-insensitive enum) plus **one** repair round closes most residual failures without a full second review. [9]

**C. Constrained decoding / grammars — guarantees format, but can cost reasoning.** Outlines, llama.cpp GBNF, and Guidance mask the token distribution to a grammar so output is *always* schema-valid. Tradeoff, per §1: the same mechanism that guarantees the shape is what depresses reasoning accuracy in "Let Me Speak Freely?" — so constrain the *final verdict field only*, not the reasoning. Not available as a first-party knob on hosted DeepSeek reasoner. [1][5]

**D. First-party Structured Outputs APIs (where available).** OpenAI's `response_format` with `json_schema` + `strict:true` *"guarantees the model will always generate responses that adhere to your supplied JSON Schema"*, and exposes a distinct **`refusal`** field so a decline is detectable rather than showing up as broken JSON — check `refusal` and `finish_reason` before parsing. Anthropic provides structured output via forced tool use (`tool_choice:{type:"tool",name:...}` with an `input_schema`) and now native structured outputs (`output_format`). These make "refused" and "malformed" *distinguishable*, which is exactly what a verdict harness needs. DeepSeek offers only the weaker `json_object` mode with the empty-content caveat above. [11][12][2]

**E. Design the contract to be reasoning-friendly.** Include a free-form `reasoning`/`scratchpad` field *before* the `verdict` field (models fill earlier keys first, so the verdict is conditioned on stated reasoning); keep the enum small; make the format instruction the *last* thing in the prompt (recency beats lost-in-the-middle). [1][7]

---

## 4. Do multi-model consensus panels add value over a single strong model?

**Largely no, for a detect/judge task.** "Nine Judges, Two Effective Votes: Correlated Errors Undermine LLM Evaluation Panels" (arXiv 2605.29800) is the key primary source: panels assume cross-model diversity yields near-independent votes, but judges make **correlated errors**, so nine judges deliver only ~**two effective independent votes**. Majority voting therefore "systematically agree[s] on the same wrong answers" instead of canceling error; the paper's practical implication is to invest in a *stronger single judge* rather than a wider panel. [10]

**Conflicting/nuanced evidence.** The Panel-of-LLM-evaluators (PoLL) line reports that a panel of three *small, disjoint-family* models can beat one large judge at ~7× lower cost by reducing single-model bias. The reconciliation: panels help mainly as a **cost/bias** play against one *weak* judge; when you already have one strong reviewer, added models bring correlated (redundant) signal plus extra parse-failure exposure. For a code-verdict harness that can afford a strong model, a single strong reviewer + tolerant parse + one repair beats an N-model consensus. [10]

---

## Where sources are thin or conflict

- **Panel value is genuinely contested:** "Nine Judges" (redundant/negative) vs. PoLL-style results (small-panel wins on cost/bias). Both are primary; they disagree on framing, not raw mechanics — decisive variable is whether the baseline is a *strong* or *weak* single judge. [10]
- **The multiplicative parse-failure exposure of panels** (§2) is an inference composed from IFScale + DeepSeek caveats + correlated-error findings, not a single measured statistic.
- **DeepSeek doc caveats are version-dated** ("expected to be resolved in the next version"); re-verify against the live docs, as the empty-content/looping behavior is explicitly said to be under active fix. [2][3]
- Some "Let Me Speak Freely?" per-model percentages were read from the paper's tables via fetch; treat exact decimals as approximate and confirm against the PDF before quoting externally. [1]

---

## Sources

1. Let Me Speak Freely? — arXiv 2408.02442 (EMNLP 2024 Industry): https://arxiv.org/abs/2408.02442 · https://aclanthology.org/2024.emnlp-industry.91.pdf
2. DeepSeek JSON Output (official): https://api-docs.deepseek.com/guides/json_mode/
3. DeepSeek Function Calling (official): https://api-docs.deepseek.com/guides/function_calling
4. DeepSeek-V3/V4 empty-response-after-tool-call issue: https://github.com/deepseek-ai/DeepSeek-V3/issues/1453
5. DeepSeek-R1 no native function calling / structured output: https://github.com/deepseek-ai/DeepSeek-R1/issues/9 · https://huggingface.co/deepseek-ai/DeepSeek-R1/discussions/122
6. How Many Instructions Can LLMs Follow at Once? (IFScale) — arXiv 2507.11538: https://arxiv.org/abs/2507.11538
7. Lost in the Middle / The Instruction Gap — arXiv 2601.03269: https://arxiv.org/html/2601.03269v1
8. (Instruction adherence vs. accuracy independence, same paper): https://arxiv.org/html/2601.03269v1
9. Instructor — Retrying (reask with validation error): https://python.useinstructor.com/concepts/retrying/ · https://github.com/567-labs/instructor
10. Nine Judges, Two Effective Votes — arXiv 2605.29800: https://arxiv.org/pdf/2605.29800 ; PoLL counterpoint: https://orq.ai/blog/llm-juries-in-practice
11. OpenAI Structured Outputs (strict json_schema + refusal field): https://openai.com/index/introducing-structured-outputs-in-the-api/ · https://developers.openai.com/api/docs/guides/structured-outputs
12. Anthropic Structured Outputs / forced tool use: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
