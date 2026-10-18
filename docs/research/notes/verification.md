# Fast, reliable verification of grounded LLM outputs (2024-2026): claim-level support checking, citation quality, numeric guards, targeted correction

Research date: 2026-10-17. Evidence quality is flagged inline: [peer-reviewed] = ACL/EMNLP/NAACL-type venue, [preprint] = arXiv only, [model card] = vendor/author page, [snippet] = only seen in a search-result summary, not read in full (treat as lower confidence). Many 2026 arXiv items (IDs 26xx.xxxxx) are very recent, single-group preprints with no replication.

Use-case reminder: each report sentence has a claim type (client fact / AFS source / external / assumption / proposal / unknown) and cites evidence cards (verbatim quote + page). So the "document" for a support check is a few short verbatim quotes, not a long document. This matters for every recommendation below.

---

## 1. Small grounding / NLI checkers (MiniCheck, Bespoke-MiniCheck, HHEM-2.1-open, LettuceDetect, AlignScore, Granite Guardian, FactCG): accuracy, latency, licence, context

### Takeaway
Specialised 0.4-0.8B checkers (MiniCheck-Flan-T5-L, FactCG-DeBERTa-L) match or beat GPT-4o-class and 70B+ open LLM judges on LLM-AggreFact (about 75-76 balanced accuracy vs 74-77 for the big models) at roughly 1/400 of the cost, and are the right first-pass tier for a short-premise task like this one. The best open checker is Bespoke-MiniCheck-7B (77.4) but it is CC BY-NC 4.0. No source I found publishes per-pair CPU/GPU latency for MiniCheck or FactCG; the only hard CPU number is HHEM-2.1-open at about 1.5 s per 2k-token input.

### Cited Findings
**Benchmark and leaderboard**
- LLM-AggreFact aggregates 11 human-annotated datasets (summarisation, QA, RAG), 13,122 test instances, metric = balanced accuracy (BAcc); class imbalance ranges from 10% to 83% negative across datasets — [AlphaXiv benchmark page, snippet](https://www.alphaxiv.org/benchmarks/the-university-of-texas-at-austin/llm-aggrefact)
- Official leaderboard page (displays only 11 of 39 selectable models; no latency/cost/licence/threshold info): Bespoke-MiniCheck-7B 77.4; Claude-3.5-Sonnet 77.2; Granite Guardian 3.3 (8B) 76.5; Mistral-Large-2 (123B) 76.5; gpt-4o-2024-05-13 75.9; FactCG-DeBERTa-L (0.4B) 75.6; Qwen2.5-72B-Instruct 75.6; MiniCheck-Flan-T5-L (0.8B) 75.0; Llama-3.3-70B-Instruct 74.5; Llama-3.1-405B-Instruct 74.4; QwQ-32B-Preview 71.8 — [LLM-AggreFact leaderboard](https://llm-aggrefact.github.io/)
- A third-party mirror (import date 2026-05-29) has the same top order — [benchmarklist.com](https://benchmarklist.com/benchmarks/llm_aggrefact/)
- Gemma-family models: I found no Gemma 3/4 score on LLM-AggreFact (see Gaps).

**MiniCheck (Tang, Laban, Durrett; EMNLP 2024) [peer-reviewed]**
- Paper numbers (10 datasets, fixed 0.5 threshold, no per-dataset tuning): MiniCheck-FT5 74.7, MiniCheck-RoBERTa-L 72.7, MiniCheck-DeBERTa-L 72.6, AlignScore 70.4, GPT-4 75.3, Claude-3 Opus 74.1, Claude-2.1 70.7, GPT-3.5 69.6 — [MiniCheck paper](https://arxiv.org/html/2404.10774v2)
- Sizes: RoBERTa/DeBERTa variants 355M, FT5 (Flan-T5-large) 770M; trained on 14K synthetic examples (Rbta) or 35K (14K synthetic + 21K ANLI subset) vs AlignScore's 4.7M examples — [MiniCheck paper](https://arxiv.org/html/2404.10774v2)
- Cost to check the 13K test set: about $0.20-0.24 for the small models (costed at $0.8/GPU-hour) vs $107 GPT-4 and $165 Claude-3 Opus; authors state >400x cheaper than GPT-4 — [MiniCheck paper](https://arxiv.org/html/2404.10774v2)
- Input form: one document + one claim -> support probability / 0-1 label; multi-sentence claims should be split into sentences first — [MiniCheck GitHub](https://github.com/Liyan06/MiniCheck)
- Licences: MiniCheck-Flan-T5-Large model card = MIT; repo = Apache-2.0 — [HF model card](https://huggingface.co/lytang/MiniCheck-Flan-T5-Large), [GitHub](https://github.com/Liyan06/MiniCheck). I could not confirm a licence for the RoBERTa/DeBERTa variants.
- Speed claims: code comment "~500 docs/min depending on hardware" for the ~29K LLM-AggreFact test set — [HF model card](https://huggingface.co/lytang/MiniCheck-Flan-T5-Large); on one A6000 the 29K test set took about 30 min with prefix caching and 55 min without (for the 7B model, long documents) — [MiniCheck GitHub](https://github.com/Liyan06/MiniCheck). No CPU latency published; the only ONNX export of MiniCheck-Flan-T5-L is a community fp32 build (about 3 GB) with no latency figures — [FamiliarTools ONNX](https://huggingface.co/FamiliarTools/MiniCheck-Flan-T5-Large-onnx)

**Bespoke-MiniCheck-7B**
- Top of the leaderboard (77.4). Model card: base model is `internlm/internlm2_5-7b-chat` (about 8B params, BF16), synthetic training data from Llama-3.1-405B-Instruct; **licence CC BY-NC 4.0 (non-commercial; commercial use needs a deal with Bespoke Labs)**; no chunking needed unless a document exceeds 32K tokens; >500 docs/min with vLLM on a single A6000 48 GB; prefix caching helps when one document is checked against many claims; available in Ollama as `bespoke-minicheck` since 2024-09 — [HF model card](https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B), [MiniCheck GitHub](https://github.com/Liyan06/MiniCheck)

**FactCG (Microsoft, NAACL 2025) [peer-reviewed]**
- Variants: FactCG-RoBERTa-L (about 0.4B), FactCG-DeBERTa-v3-L (about 0.4B), FactCG-Flan-T5-L (about 0.8B). Paper (with threshold tuning): DBT 77.2, FT5 76.7, RBT 75.4 vs GPT-4o 75.9, MiniCheck-FT5 75.5, AlignScore 72.5. On the leaderboard (no tuning) FactCG-DeBERTa-L = 75.6 — [FactCG paper](https://arxiv.org/html/2501.17144), [leaderboard](https://llm-aggrefact.github.io/)
- Method: CG2C builds context graphs from documents and generates multi-hop claims, with no LLM labelling; training sets 8,213 (CG2C-MHQA) and 6,433 (CG2C-Doc) examples on top of MiniCheck's data — [FactCG paper](https://arxiv.org/html/2501.17144), [ACL Anthology](https://aclanthology.org/2025.naacl-long.258)
- Long documents are split into sentence-aligned chunks (400 tokens for RoBERTa, 550 for DeBERTa/T5) and the max chunk score is the final score — [FactCG paper](https://arxiv.org/html/2501.17144). Licence not verified.

**HHEM-2.1-open (Vectara)**
- 0.1B params (flan-t5-base fine-tune), Apache-2.0, "unlimited" context (HHEM-1.0 was capped at 512), <600 MB RAM at fp32, about 1.5 s for a 2k-token input on a modern x86 CPU. Input = (premise, hypothesis) -> score 0-1; **the card gives no recommended threshold** — [HF model card](https://huggingface.co/vectara/hallucination_evaluation_model)
- Vendor-reported balanced accuracy: AggreFact-SOTA 76.55 (HHEM-1.0 78.87, GPT-4 73.78); RAGTruth-Summ 64.42; RAGTruth-QA 74.28 (GPT-4 74.11). It does not report a full LLM-AggreFact average — [HF model card](https://huggingface.co/vectara/hallucination_evaluation_model)
- Known behaviour: asymmetric (a hypothesis that is a generalisation of the premise is consistent, the reverse is flagged); factually true but unsupported claims are flagged as hallucinated — i.e. it checks grounding, not truth. Model is derived from T5 pre-trained on short sequences, so long-context quality is weaker (commercial model is better) — [HF model card](https://huggingface.co/vectara/hallucination_evaluation_model), [Vectara blog snippet](https://www.vectara.com/blog/hhem-2-1-a-better-hallucination-detection-model/)
- On the hard FaithBench, HHEM-2.1-open claim-wise had the best detector F1 (63.7) among the zero-shot detectors tested, but detectors overall were "modest" — [FaithJudge paper](https://arxiv.org/html/2505.04847v2)

**LettuceDetect (KR Labs, 2025) [preprint]**
- ModernBERT token classifier over (context, question, answer) that outputs unsupported spans. Base 150M, large 396M; trained on RAGTruth only (binary label); max 4,096 tokens (paper says the full 8,192 ModernBERT context is not used); 30-60 examples/s on a single GPU; MIT licence — [LettuceDetect paper](https://arxiv.org/html/2502.17125v1)
- RAGTruth example-level F1: large 79.22, base 76.07, fine-tuned Llama-2-13B 78.7, RAG-HAT (fine-tuned Llama-3-8B) 83.9, Luna 65.4, GPT-4-turbo prompt-based 63.4. Span-level F1: large 58.93, base 55.44, fine-tuned Llama-2-13B 52.7, GPT-4-turbo prompt 28.3 — [LettuceDetect paper](https://arxiv.org/html/2502.17125v1)
- TinyLettuce (17-68M Ettin encoders, 8K context, MIT, "real-time on CPU"): author-reported 90.87% F1 on their own synthetic data; I found no independent RAGTruth numbers — [HF author page, snippet](https://huggingface.co/adaamko)

**Granite Guardian 3.3 8B (IBM)**
- Apache-2.0, 8B, BF16; groundedness is one of three RAG criteria (with context relevance and answer relevance); optional "think" mode (reasoning trace then `<score>`); LLM-AggreFact avg BAcc 0.761 (no-think) / 0.765 (think) on IBM's own run, TRUE avg 0.777 / 0.773, RAGTruth column 0.831 / 0.821; no latency or context-length figures on the card (think mode produces longer outputs, `max_tokens=2048` in example) — [HF model card](https://huggingface.co/ibm-granite/granite-guardian-3.3-8b)
- Original Granite Guardian paper (3.0 family, 2B/8B): AUC 0.871 on guardrail and 0.854 on RAG-hallucination benchmarks — [arXiv 2412.07724, snippet](https://arxiv.org/pdf/2412.07724v1)

**AlignScore (2023)**: 355M RoBERTa-L, trained on 4.7M examples; 70.4 BAcc in the MiniCheck paper table (superseded by MiniCheck/FactCG) — [MiniCheck paper](https://arxiv.org/html/2404.10774v2)

### Inferences
- Because every sentence is checked against 1-3 short quotes (maybe 50-300 tokens total), the chunking problem that dominates published latency numbers disappears. Sentence + quote(s) is the exact input format MiniCheck/FactCG were trained on. (Inference from the input formats above.)
- Cost/accuracy ranking for this case: FactCG-DeBERTa-L (0.4B, 75.6 leaderboard / 77.2 tuned) and MiniCheck-Flan-T5-L (0.8B, 75.0, MIT) are the best accuracy per FLOP; Bespoke-MiniCheck-7B (77.4) is about +2 points for roughly 10-20x the compute and a non-commercial licence (fine for a hackathon/research prototype, a blocker for a product); Granite Guardian 3.3 8B is Apache-2.0 and near the top but is an 8B generative model with unspecified latency, so it is a candidate for the "escalate" tier rather than the first pass.
- A generic 31B LLM judge is probably not better than the 0.4-0.8B specialists: comparable general models on the leaderboard (Qwen2.5-72B 75.6, Llama-3.3-70B 74.5, QwQ-32B 71.8) score at or below FactCG-DeBERTa-L (75.6). This is an extrapolation; Gemma was not found on the board.
- Latency estimate (NOT measured; extrapolated from HHEM's 1.5 s / 2k tokens on CPU and the GPU throughput figures above): on GPU, a 0.4-0.8B checker should process a whole 30-60 sentence report in well under 1 s when batched; on CPU a 0.4B encoder on 100-300-token inputs is plausibly 0.1-0.4 s per pair, i.e. a few seconds sequentially but near 1-2 s with batching/threads/int8-ONNX. Benchmark on the target machine before committing to the < 2 s budget.
- Do not treat the fixed 0.5 threshold as sacred. FactCG's own numbers rise (e.g. 75.6 -> 77.2 for DBT) with threshold tuning, and HHEM's card gives no threshold. Plan to tune on your own labelled sentences (see Q6).
- LettuceDetect is attractive only as a *localiser* (which span of the sentence is unsupported) for targeted repair; it was trained only on RAGTruth (QA / data-to-text / summarisation of everyday text), so domain shift to spectroscopy/process-analytics prose is a real risk, and its sentence-level F1 (about 76-79) is not better than MiniCheck-class models on LLM-AggreFact.

### Gaps
- No published per-pair latency (CPU or GPU) for MiniCheck-FT5, FactCG or Bespoke-MiniCheck on short inputs; the only CPU figure is HHEM (1.5 s / 2k tokens). Needs a local benchmark.
- No Gemma 3/4 (or any ~30B Gemma) score on LLM-AggreFact located; the leaderboard page only rendered 11 of 39 models.
- Licences for FactCG and MiniCheck-RoBERTa/DeBERTa not verified.
- LLM-AggreFact is mostly news/summarisation/QA/Wikipedia text; none of it is technical/scientific process-analytics prose, so out-of-domain accuracy is unknown (no source tests this).

---

## 2. LLM-as-judge for support vs small checkers: human agreement, calibration, cost

### Takeaway
Zero-shot LLM judges are not clearly better than fine-tuned small checkers at grounding (best zero-shot on the hard FaithBench set is about 68.8 BAcc), they cost orders of magnitude more, and high run-to-run consistency does not imply agreement with humans. Judge accuracy improves substantially when the prompt includes human-annotated examples (FaithJudge), which is directly applicable to your "critic is too strict" worry.

### Cited Findings
- FaithJudge (Vectara; judge sees nine human-annotated peer responses to the same source): FaithBench BAcc/F1-macro o3-mini-high 84.0/82.1, GPT-4o 79.5/81.1, Llama-3.3-70B 77.5/77.8, Qwen-2.5-72B 73.2/73.0; zero-shot judges with the FACTS prompt reach at most 68.8 BAcc / 60.7 F1; on RAGTruth QA FaithJudge F1 83.4 vs 76.9 for the FACTS prompt with the same o3-mini-high; more annotated examples raise sensitivity while specificity stays high but dips slightly; a 3-judge majority vote did not beat the best single judge; FaithJudge under-predicts hallucination for some generators — [FaithJudge paper, preprint](https://arxiv.org/html/2505.04847v2)
- Same paper: zero-shot LLMs average below about 78% BAcc and 72% F1 across datasets, and fine-tuned detectors (MiniCheck, HHEM, AlignScore) are "similarly modest"; human inter-annotator disagreement is part of the gap — [FaithJudge paper](https://arxiv.org/html/2505.04847v2)
- Benchmark of reference-free RAG detectors (LLM-as-judge, Prometheus, Lynx, HHEM, TLM) on six RAG applications: some "consistently detect incorrect RAG responses with high precision/recall"; abstract does not say which, and I could not read the numbers — [arXiv 2503.21157, preprint](https://arxiv.org/abs/2503.21157)
- Human-vs-GPT-4o support judgments (TREC 2024 RAG track): manual from-scratch assessments match GPT-4o perfectly on a 3-level scale for 56% of items (72% with post-editing); run-level Kendall tau > 0.79; an independent human agreed more with GPT-4o (kappa 0.27) than with the original human assessor (kappa 0.07) — i.e. human labels themselves are noisy — [arXiv 2504.15205, snippet](https://arxiv.org/abs/2504.15205v1)
- Local open-weight judges can be self-consistent without being aligned: LLaMA-3-8B and Qwen2.5-7B judges had 97.3% / 92.3% exact self-consistency but Pearson r only 0.275 / 0.340 against nine human raters (different task: scoring GPT-2 responses 1-100; small study, one author) — [arXiv 2609.13824, preprint](https://arxiv.org/abs/2609.13824)
- GroUSE: existing automated RAG evaluation frameworks "often overlook important failure modes, even with GPT-4 as the judge"; open-source judges correlate strongly with GPT-4 but do not generalise to the criteria; fine-tuning Llama-3 on GPT-4 reasoning traces improved calibration; "correlation with GPT-4 is an incomplete proxy" for judge quality (144 unit tests, 7 failure modes) — [GroUSE](https://arxiv.org/abs/2409.06595)
- "Verify with Caution": five state-of-the-art factuality metrics re-evaluated on 11 datasets are inconsistent with each other, misestimate system-level performance, and are biased against heavily paraphrased outputs and outputs that draw on source parts far from the relevant context; authors advise validating a metric in-domain before use — [Godbole and Jia 2025, preprint](https://arxiv.org/abs/2501.14883)
- Cost reference: GPT-4 $107 vs about $0.20 for a 355M checker to score the 13K LLM-AggreFact test set — [MiniCheck paper](https://arxiv.org/html/2404.10774v2)

### Inferences
- The ~65% "supported" rate is at least partly a *judge artefact* risk, not only draft over-reach: (a) the critic is a generic 31B model with no known LLM-AggreFact score, (b) metrics are biased against paraphrase and against evidence far from the point of use (Godbole and Jia), which describes exactly "claim paraphrases the quote in plainer language" and "claim synthesises two cards", and (c) a strict binary supported/unsupported prompt forces partial support into "unsupported". Verifiable diagnostic: run the same sentences through a specialist checker and a few-shot critic and compare to ~150 expert labels; if the specialists say 80-85% supported while experts agree, the critic is over-strict.
- Do not use critic self-consistency as evidence of quality (97% consistency coexisted with r of 0.28-0.34 in the one study found); calibrate against expert labels.
- Cheapest improvement to the existing critic: add 6-12 expert-labelled examples per claim type (including "partial" and "paraphrase" cases) to the prompt, FaithJudge-style; expect higher sensitivity and some loss of specificity.

### Gaps
- No paper found that directly compares a small fine-tuned checker to a ~30B open LLM judge on technical/scientific attribution; evidence is by analogy.
- Gemma-specific judge reliability not found.
- Calibration curves (reliability diagrams/ECE) for MiniCheck/HHEM/FactCG probabilities were not found; only accuracy at fixed thresholds.

---

## 3. Citation/attribution evaluation: ALCE, attribution benchmarks, sentence-to-quote alignment, citation precision/recall

### Takeaway
ALCE's definitions (statement-level citation recall using the concatenation of all cited passages; per-citation precision that penalises irrelevant citations) map one-to-one onto your evidence-card setup. Its main caveat is the one you are probably hitting: NLI-style checkers cannot represent "partial support".

### Cited Findings
- Citation recall = 1 for a statement only if it has at least one citation and an NLI model (TRUE, T5-11B) judges the concatenated cited passages to support it; citation precision is per citation: a citation is "irrelevant" if it alone fails to support the statement AND removing it leaves the rest supporting it; precision = 1 only if the statement's recall = 1 and the citation is not irrelevant — [ALCE paper, EMNLP 2023](https://arxiv.org/html/2305.14627)
- Agreement with humans: ELI5 Cohen's kappa 0.698 for recall (substantial), 0.525 for precision (moderate); ChatGPT+Rerank automatic recall 83.9 vs human 79.3 on ASQA — [ALCE paper](https://arxiv.org/html/2305.14627). Appendix accuracies: recall 85.1%, precision 77.6% vs human gold [snippet] — [ALCE search summary](https://arxiv.org/pdf/2305.14627)
- Stated limitation: the NLI model cannot detect "partially supports", so a partly supporting citation may be counted as irrelevant, giving lower precision than humans — [ALCE paper](https://arxiv.org/html/2305.14627)
- Best systems still fall short: on ELI5 even the best lack complete citation support about 50% of the time (ChatGPT+Rerank recall 69.3 / precision 67.8; GPT-4 20-passage 48.5 / 53.4); ASQA ChatGPT+Rerank 84.8 / 81.6 — [ALCE paper](https://arxiv.org/html/2305.14627)
- What improved citation quality in ALCE: **Rerank** (sample four responses, keep the one with best automatic citation recall) consistently helped (human-confirmed); summaries/snippets raised correctness but lowered citation quality; interactive retrieval did not help — [ALCE paper](https://arxiv.org/html/2305.14627)
- RARR's attribution metric (AIS, "attributable to identified sources") is sentence-level; the automatic version uses an NLI model and correlated 0.74 (Pearson) with human judgments — [RARR](https://ar5iv.labs.arxiv.org/html/2210.08726)
- VeriScore (EMNLP Findings 2024) criticises FActScore/SAFE for treating all text as checkable (including examples and hypotheticals), and extracts only *verifiable* claims before checking; humans rated its claims more sensible across eight long-form tasks — [VeriScore](https://arxiv.org/pdf/2406.19276)
- Benchmarks that assume the MiniCheck-style recipe: split multi-sentence outputs into sentences/atomic claims, then score each (document, claim) pair — [MiniCheck GitHub](https://github.com/Liyan06/MiniCheck), [Bespoke card](https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B)

### Inferences
- Metrics to report for your system, borrowed directly: citation recall (does concatenation of the sentence's cited quotes entail the sentence?), citation precision (per cited card, would removal still leave support?), and a stricter "quote-locality" rate; ALCE's precision definition gives you a cheap automated check that catches *citation padding* (extra cards that add nothing) without any new model, by re-running the small checker with each card removed.
- Claim-type gating mirrors VeriScore: only "client fact / AFS source / external" sentences are *verifiable*. "Assumption / proposal / unknown" sentences should not be scored for quote support at all (they should be checked for correct labelling and hedging language instead). Counting them as "unsupported" would depress the 65% figure artificially. Worth checking how the current critic treats them.
- Sentences that synthesise across two cards are the classic failure for sentence-level NLI (ALCE concatenates; FactCG/MiniCheck were explicitly trained for multi-sentence synthesis), so always pass the concatenation of all cited quotes and keep the sentence-level prompt.

### Gaps
- No spectroscopy/engineering-domain attribution benchmark found. No source gives "sentence-to-quote alignment" accuracy (i.e. which quote within a card supports which clause) beyond ALCE's concatenation approach.
- ALCE appendix details beyond about 100K characters of the HTML were not read.

---

## 4. Post-hoc correction: RARR, targeted sentence-level rewrite vs regenerate-all, deleting vs rewriting, generate-then-verify-then-patch vs single-shot

### Takeaway
Verifier-driven, constrained, per-claim edits are the best-supported approach: they raise attribution while preserving most of the draft (RARR 83-85% preservation), whereas intrinsic self-correction without external feedback does not reliably help (and sometimes hurts). Deleting an unsupported claim removes the most unsupported content but loses text; rewriting preserves more but is least effective at removing unsupported content. There is no good head-to-head evidence "patch vs regenerate-all" in the literature I found.

### Cited Findings
**RARR (Google, ACL 2023) [peer-reviewed; uses PaLM + Google Search]**
- Pipeline: generate questions about the passage, retrieve evidence, an *agreement model* checks each evidence snippet against the current text, and an *edit model* minimally revises only on conflict; edits larger than 50 characters or 0.5x original length are rejected — [RARR](https://ar5iv.labs.arxiv.org/html/2210.08726)
- Results (PaLM outputs, auto-AIS before -> after, preservation): NQ 45.6 -> 54.9 with preservation 83.1 (F1_AP 57.0) vs EFEC 45.6 -> 64.3 but preservation 10.4 (F1_AP 17.1) and LaMDA 39.5 -> 49.9, preservation 21.1; SQA 37.6 -> 45.1, preservation 84.6; QReCC 18.8 -> 29.4, preservation 78.1; human oracle edit reaches F1_AP 93.6 — [RARR](https://ar5iv.labs.arxiv.org/html/2210.08726)
- Ablation: removing the agreement model causes over-editing; downstream NQ accuracy +5%, but SQA accuracy dropped by up to 2.6% with noisy evidence; RARR "tends to keep unattributable claims rather than delete them"; early corrections often fail to propagate to dependent later sentences; no per-passage LLM-call count or latency is reported ("computationally costly") — [RARR](https://ar5iv.labs.arxiv.org/html/2210.08726)

**Claim-level repair strategies (2026 preprint, RAGTruth, 916 answers)**
- Compared leave-unchanged vs delete the unsupported claim vs replace with source text vs rewrite. All strategies reduce judged unsupported content; **deletion gives the largest reduction but retains least text (64.3%)**; **rewriting retains 80.1% but reduces unsupported content least**; 83.5% of answers annotated *clean* were also edited (over-editing); authors argue the choice is a grounding-vs-preservation trade-off that automatic metrics cannot settle. Three judges from different families agreed on the ordering — [arXiv 2608.29307, preprint](https://arxiv.org/abs/2608.29307)
- A September 2026 preprint where an LLM only *selects* evidence sentences and deterministic code substitutes them verbatim: 12 of 32 human-labelled hallucinations net-fixed on 889 RAGTruth responses (37.5%), 26 of 110 grounding failures fixed on ExpertQA (23.6%) — modest — [preprints.org 202609.0490, search snippet only (fetch returned 403)](https://www.preprints.org/manuscript/202609.0490)

**Detect-then-correct systems**
- Medico (EMNLP 2024 demo): corrector first identifies hallucinated spans, then revises only them; to avoid superfluous edits it uses a Levenshtein-based preservation score and rejects revisions below a threshold; loops until detector approves; abstract reports detection F1 0.927-0.951 and correction approval 0.973-0.979 (self-reported, model names not in abstract) — [Medico abstract](https://arxiv.org/abs/2410.10408), [preservation detail, search snippet](https://arxiv.org/pdf/2410.10408)
- Vectara Hallucination Correction Model: a post-editor taking (reference documents, response), without the user query, attempting to "only fix those parts of the original response that are hallucinated"; fails when large deletions/additions are needed; improved factuality rate for all 15 leaderboard models (numbers only in figures); uses HHEM-2.1 to measure; open-source status/latency not stated — [Vectara blog](https://vectara.com/blog/correcting-hallucinations-in-large-language-models/)

**Self-correction vs verifier-driven**
- "LLMs cannot self-correct reasoning yet" (ICLR 2024): intrinsic self-correction (no external feedback) struggles and can lower accuracy — [Huang et al.](https://arxiv.org/abs/2310.01798)
- Chain-of-Verification (draft -> plan verification questions -> answer them independently -> final verified response) reports reduced hallucination across list QA, closed-book MultiSpanQA and long-form generation; abstract gives no numbers — [CoVe](https://arxiv.org/abs/2309.11495)
- ALCE: sampling several responses and picking the one with best automatic citation recall (Rerank) improved citation quality, human-confirmed — [ALCE](https://arxiv.org/html/2305.14627)

### Inferences
- A whole-report repair (about 30 s) is the wrong default: it re-opens every supported sentence (83.5% of clean answers were edited in the claim-level-repair study even when only flagged claims were meant to change), re-rolls other claims, and cannot be bounded. Patch only the failing sentences, one LLM call each (or one batched call with sentence ids), preserving all passing sentences byte-for-byte. Expect each patch call to take about the same time as a single-sentence generation (a few seconds on a 30B model, parallelisable) rather than 30 s for the report. (Latency is an inference; not measured.)
- Choose the action per failure by claim type, since "delete" and "rewrite" have different costs here: (i) AFS-source/client-fact sentence with a wrong number or overreach -> rewrite *constrained to the cited quote* (the RARR/Medico edit-size cap is directly reusable); (ii) sentence with no support at all -> relabel as assumption/unknown/proposal with explicit hedging, or delete if it adds nothing; (iii) external-knowledge claim without a card -> keep only if marked external with a card, else downgrade to assumption. Relabelling is a cheaper "fourth option" than the delete/replace/rewrite set in the literature, and it preserves information while removing a false grounding implication. This is a design inference, not a tested result.
- Always re-verify the patched sentence with the same checker (verifier-in-the-loop). The external-feedback finding (Huang) and Medico's detector-approval loop both support cap-and-verify (e.g. max 2 iterations), after which fall back to deletion/downgrade.
- Rerank-style best-of-n (ALCE) is a latency/compute trade you could apply only to sentences that fail: sample 2-4 candidate rewrites and keep the one with highest checker score. With a 5-50 ms checker this is cheap relative to generation.

### Gaps
- No head-to-head study of "targeted sentence patching" vs "regenerate everything" with latency/cost; no study in a technical-report domain.
- RARR numbers use PaLM + web search, not a closed evidence set; Medico/HCM numbers are self-reported and in different data regimes.
- Preprint 202609.0490 could only be read via a search snippet.

---

## 5. Numeric and unit hallucination guards in scientific text; entity/number consistency checks

### Takeaway
Neural support checkers are weak on numbers/units, especially on *equivalent* rewrites (95 C vs 368.15 K), so the deterministic number guard should stay but be upgraded from string matching to unit-aware normalisation. Detecting numeric/entity errors is a problem sentence-level NLI models are reported to miss.

### Cited Findings
- Typed numeric/unit verification (single-author preprint, May-Jul 2026): 1,500 items rewritten from PMC and arXiv, five-class typed-quantity error taxonomy, labels from two LLM annotators with adjudication (Krippendorff alpha 0.882). A fine-tuned ModernBERT encoder gets macro-F1 0.899 in-distribution but only **36.5% accuracy on canonical-equivalent rewrites** (e.g. 95 C vs 368.15 K); "Symbolic Augmentation" (running a symbolic verifier in reverse to generate label-preserving training data) raises that to 98.2%, in-distribution macro-F1 0.899 -> 0.902, and SciFact-Open binary macro-F1 0.791 -> 0.828; adding symbolic features as auxiliary inputs gave no benefit — [arXiv 2607.16212 via AlphaXiv](https://www.alphaxiv.org/abs/2607.16212). The abstract speaks of "any off-the-shelf neural fact-checker"; it does not name MiniCheck/HHEM/AlignScore.
- MeasHalu (ACL Findings 2026): taxonomy of scientific *measurement* hallucinations across quantities, units, modifiers and relations [snippet] — [ACL Anthology](https://preview.aclanthology.org/ingest-acl/2026.findings-acl.1386/)
- Entity-aware verification (arXiv 2609.08267): argues sentence/paragraph-level detectors miss precise entity errors (wrong names, dates, quantities) because overall coherence stays high, and decomposes into atomic units. Only the abstract-level summary via search snippet; the PDF was not machine-readable — [arXiv 2609.08267](https://arxiv.org/pdf/2609.08267)
- Peer-context outlier detection for corrupted numerical values in scientific papers: up to 98% precision on synthetic injected errors, 79.2% precision in the overall multi-domain experiment [snippet; synthetic corruption] — [arXiv 2604.01461](https://arxiv.org/pdf/2604.01461)
- HalluMat (materials science): multi-stage verification (retrieval + contradiction graph + metrics) reports a 30% reduction in hallucination rates vs standard LLM outputs [snippet] — [arXiv 2512.22396](https://arxiv.org/html/2512.22396v1)
- LettuceDetect gives span-level localisation (F1 58.93 large on RAGTruth) which can point at the offending number token — [LettuceDetect paper](https://arxiv.org/html/2502.17125v1)

### Inferences
- Keep the existing rule "no number in a sentence that is absent from its cited quotes", but make it unit-aware: parse (value, unit, uncertainty/comparator) tuples, normalise to SI (e.g. with a units library), tolerate rounding and ranges, and treat derived values (sums, ratios, percent-to-fraction, C-to-K) as valid only when the sentence marks them as computed from named cited quantities. This avoids false "unsupported" flags that would otherwise lower the support rate and also avoids the neural-checker blind spot on equivalent units. (Design inference from the 36.5% vs 98.2% result; single-paper evidence.)
- Extend the guard from numbers to *quantity roles*: instrument/technique names, wavelengths/wavenumbers/ranges, comparators ("at least", "up to", "approximately"), and negation. The same parse also catches "range widened" and "upper bound turned into point value" errors that NLI models often accept.
- Run the numeric guard BEFORE the neural checker and short-circuit: numeric mismatch = hard fail, no model call needed; numerics all match = pass to the semantic checker (which is then only responsible for relation/overreach/guarantee wording).

### Gaps
- The numeric-equivalence and entity-aware papers are 2026 preprints, single groups, not replicated; I could not verify which off-the-shelf checkers they tested.
- No source benchmarks MiniCheck/FactCG/HHEM on numeric-heavy scientific claims specifically.
- No source on spectroscopy-specific unit pitfalls (cm^-1 vs nm vs um, absorbance vs transmittance, SNR definitions).

---

## 6. Evaluation frameworks for RAG (RAGAS, ARES, TruLens, DeepEval): trustworthy metrics and calibrating an LLM judge against expert scores

### Takeaway
The only framework with a built-in statistical link between judge and humans is ARES (prediction-powered inference with about 150+ labelled datapoints giving confidence intervals). RAGAS faithfulness is broadly concordant with manual review in the one independent domain study found, but meta-evaluations (GroUSE) show these frameworks miss failure modes even with GPT-4 as the judge. For your purposes a 150-300 sentence expert-labelled set is the calibration instrument; the frameworks are secondary.

### Cited Findings
- ARES: builds lightweight judges fine-tuned on synthetic data for context relevance, answer faithfulness, answer relevance; uses prediction-powered inference (PPI) so that judge predictions on a large unlabeled set are rectified by a small human-labelled validation set, giving confidence intervals; requires about 150+ human-annotated datapoints; a secondary summary claims about 78% fewer human annotations needed [summary] — [ARES](https://arxiv.org/html/2311.09476v2)
- RAGAS: reference-free metrics (faithfulness, answer relevance, context relevance); agreement with humans was measured as accuracy on WikiEval — [RAGAS](https://arxiv.org/pdf/2309.15217). An independent telecom-domain study found faithfulness "generally concordant" with manual review but the other RAGAS metrics less reliable; claim decomposition granularity introduces score variation — [telecom evaluation](https://arxiv.org/pdf/2407.12873)
- GroUSE found existing automated RAG evaluation frameworks overlook failure modes even with GPT-4; the paper compared RAGAS and DeepEval scores to three human annotators; I could not retrieve per-framework numbers — [GroUSE](https://arxiv.org/abs/2409.06595)
- Faithfulness measures adherence to provided context, not correctness of the context (a faithful answer from stale context scores perfectly) [practitioner post, snippet] — [Level Up Coding](https://levelup.gitconnected.com/rag-evaluation-in-practice-faithfulness-answer-relevance-and-context-precision-in-ragas-ce13b0363cda)
- General advice from the factuality-metric re-evaluation: validate any metric in your own domain before relying on it — [Godbole and Jia](https://arxiv.org/abs/2501.14883)
- LLM-AggreFact scoring convention: BAcc = mean of TPR and TNR, because class imbalance varies a lot across datasets — [AlphaXiv benchmark page](https://www.alphaxiv.org/benchmarks/the-university-of-texas-at-austin/llm-aggrefact)

### Inferences
- Calibration protocol (small, cheap, standard): (1) have the domain expert label 150-300 sentences from real reports on a 3-level scale (supported / partially supported / unsupported) plus claim type; double-label 30-50 for inter-annotator kappa; (2) compute BAcc/precision/recall of the current critic and of 2-3 small checkers against those labels; (3) pick per-checker thresholds (and a "grey band") to maximise BAcc or to hit a target precision on "unsupported"; (4) with ARES-style PPI report the support rate with a confidence interval rather than a bare 65%; (5) re-run on every model/prompt change as a regression test (GroUSE-style unit tests with known failure cases: paraphrase, synthesis across cards, number tamper, overreach "will guarantee", unit conversion).
- Most trustworthy metrics for this case: claim-level support (sentence vs concatenated cited quotes), citation precision/recall (ALCE style), and deterministic number/unit consistency. Answer-relevance/context-relevance-type metrics (RAGAS, TruLens, DeepEval) are not informative here since retrieval is replaced by curated cards. I did not find independent evidence for TruLens or DeepEval accuracy (see Gaps).
- If a LLM-judge must remain, use FaithJudge-style expert-labelled examples in the prompt and keep a held-out expert set to check for drift.

### Gaps
- No peer-reviewed or independent accuracy study of TruLens or DeepEval metrics found; GroUSE mentions DeepEval/RAGAS but per-framework results were not retrievable.
- RAGAS paper numbers (WikiEval accuracies) were not read, only summarised in search snippets.
- No source for calibrating zero-shot judge *probabilities* (isotonic/Platt) on grounding tasks was found.

---

## 7. Recommended verification architecture, latency budget (< 2 s target), and handling borderline "partially supported" claims

### Takeaway
Use a tiered cascade: deterministic number/id/wording checks (ms), a small specialist grounding checker over every verifiable sentence (tens-hundreds of ms), an LLM critic only for the grey band (seconds, and only for a handful of sentences), then per-sentence constrained repair with re-verification. This puts the common path under 2 s and moves the expensive 8 s critic and 30 s whole-report repair off the critical path. These are design inferences built on the evidence in sections 1-6; the latency numbers are estimates that need local benchmarking.

### Cited Findings (supporting evidence for the design; details in earlier sections)
- Small specialists match GPT-4o-class judges on LLM-AggreFact at about 1/400 the cost — [MiniCheck](https://arxiv.org/html/2404.10774v2), [leaderboard](https://llm-aggrefact.github.io/), [FactCG](https://arxiv.org/html/2501.17144)
- HHEM-2.1-open: about 1.5 s per 2k tokens on CPU, <600 MB RAM — [HF card](https://huggingface.co/vectara/hallucination_evaluation_model); LettuceDetect 30-60 examples/s on one GPU — [paper](https://arxiv.org/html/2502.17125v1); Bespoke-MiniCheck-7B >500 docs/min on one A6000 — [HF card](https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B)
- NLI-based citation checks cannot represent partial support — [ALCE](https://arxiv.org/html/2305.14627)
- Edit-size caps, preservation scores and verifier loops control over-editing — [RARR](https://ar5iv.labs.arxiv.org/html/2210.08726), [Medico](https://arxiv.org/pdf/2410.10408)
- Deleting vs rewriting trade-off (64.3% vs 80.1% text retained) — [arXiv 2608.29307](https://arxiv.org/abs/2608.29307)
- Few-shot expert-labelled examples raise judge sensitivity — [FaithJudge](https://arxiv.org/html/2505.04847v2)
- Neural checkers miss equivalent-unit numerics (36.5%) — [arXiv 2607.16212](https://www.alphaxiv.org/abs/2607.16212)

### Inferences
**Proposed pipeline (per sentence, all sentences in parallel / batched)**

| Tier | What | Where it runs | Est. latency (unmeasured) | Notes |
|---|---|---|---|---|
| 0 | Structural policy: citation ids exist, claim-type vs. cards consistent, forbidden wording (guarantee/always/will), claim-type gating (skip support scoring for assumption/proposal/unknown but check hedging language) | CPU, code | <10 ms | already exists |
| 1 | Unit-aware numeric/entity guard: parse quantities+units+comparators, normalise, match against cited quotes; derived numbers need an explicit "computed from" marker | CPU, code (units library) | <50 ms | hard-fail on mismatch, no model call |
| 2 | Small grounding checker on (concat of cited quotes, sentence): FactCG-DeBERTa-L or MiniCheck-Flan-T5-L (+ optionally Bespoke-7B if licence allows, or Granite Guardian 3.3 8B as higher-accuracy second opinion) | GPU if available, else CPU int8/ONNX | batch of 30-60 pairs: about 0.1-1 s GPU; 1-3 s CPU (extrapolated) | 3 outcomes: score >= hi -> supported; score <= lo -> unsupported; between -> grey band |
| 3 | Grey-band only: LLM critic (Gemma) with 3-level rubric (supported / partially supported / unsupported) + expert few-shot examples + per-clause rationale | existing Gemma 31B | about 8 s per call but only for the 10-25% of sentences in the grey band, run concurrently | produces the "which clause is unsupported" signal for repair |
| 4 | Per-sentence patch of failures only (relabel claim type / rewrite constrained to quote / delete), cap edit size (RARR: 50 chars or 0.5x) and re-run tiers 0-2 on the patched sentence, max 2 iterations, then fall back to delete/downgrade | Gemma, parallel per sentence | about 2-5 s per failed sentence in parallel | do not touch passing sentences |

- Latency budget reading: the "< 2 s" target is achievable for tiers 0-2 (verdict on every sentence), not for tier 3/4. Make tiers 0-2 synchronous (the report is validated interactively) and tiers 3-4 asynchronous "polish" or applied only to flagged sentences, with the UI showing the fast verdicts immediately. Note HHEM's 1.5 s / 2k tokens is the only real CPU datapoint; prefer a GPU for the checker if any is free, since a 0.4B model needs only a fraction of a GB.
- **Borderline "partially supported" handling** (because NLI cannot represent partial support and Rerank-type scores will cluster in the middle):
  1. Split into atomic claims first (MiniCheck/Bespoke guidance; VeriScore-style), score each clause; "partial" = some clauses pass and some fail. Do not let a single mid-range sentence score decide.
  2. Define a grey band (e.g. 0.3-0.7, tuned on the expert set) rather than a single 0.5 cut; route the band to the LLM critic with an explicit 3-level rubric and ask it to name the unsupported clause.
  3. For partial support, keep the supported clause verbatim, and either (a) hedge/relabel the unsupported clause as assumption/proposal/unknown, or (b) delete it; never "upgrade" it by rewriting to sound stronger. Rewriting retains more text but is least effective at eliminating unsupported content in the one head-to-head study (80.1% retained), so apply it only when a cited quote actually contains the missing information.
  4. Report partial-support rate as its own metric next to supported/unsupported; consider counting it as pass for informational sentences and fail for "client fact"/numeric sentences (policy decision, needs the expert).
- **Where the 65% likely comes from (testable)**: claim types that should not be scored (assumption/proposal/unknown), synthesis across cards (needs concatenation), paraphrase and unit conversion, and a binary prompt with no partial category. Measure each category's contribution on the expert set before changing the generator.
- **Cost**: tier 2 on GPU or CPU is essentially free relative to LLM calls (about $0.20 per 13K pairs in the MiniCheck paper at $0.8/GPU-hour); the main saving comes from shrinking the number of 8 s critic calls and replacing the 30 s whole-report repair with 0-3 targeted calls.
- Suggested build order: (1) label ~150-300 sentences, (2) run MiniCheck-FT5 and FactCG-DBT zero-shot against them and against the current critic and compare, (3) add unit-aware numeric guard, (4) add the grey-band cascade, (5) replace whole-report repair with per-sentence constrained patching, (6) track support rate with a confidence interval over time.

### Gaps
- All latency figures for small checkers on CPU/GPU for this specific input size are extrapolations; no published source.
- No evidence found for the effect of this exact cascade on a technical-feasibility-report corpus; no domain benchmark for in-line spectroscopy exists in the sources found.
- Thresholds (grey band) are not transferable; they must come from the expert-labelled set.
- Licence constraints: Bespoke-MiniCheck-7B is CC BY-NC 4.0; confirm FactCG and MiniCheck-DeBERTa/RoBERTa licences before shipping.
