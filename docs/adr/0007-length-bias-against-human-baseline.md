# 0007: Measure length bias against a human baseline

Status: accepted

## Context
Judges tend to favour longer answers. But longer answers are often better, so "the judge scores longer answers higher" does not by itself show bias. We need a check that separates a length preference from real quality, using data EvalKit already has.

## Decision
- Score runs: compute the length-score Spearman correlation for every rater, and for each judge the gap to the human on the same samples. Flag only when a bootstrap interval for the gap is entirely above 0.
- Pairwise runs: compute how often the longer response wins. Also compute it on pairs the human called a tie, since there the human saw no quality difference, so a rate clearly above 50% points to length preference. Flag when the Wilson interval on that subset is above 50%.
- Ignore pairs whose lengths differ by less than a threshold (default 10%), and ties and order-flipped judge verdicts.
- Do not store response text in runs. The bias commands take the dataset file and refuse it unless its SHA-256 matches the run.

## Consequences
- The human is the baseline, so the strongest evidence needs human scores or preferences in the dataset. Without them the report still shows correlations but says it cannot tell bias from quality.
- Runs stay small and do not retain potentially sensitive text. The cost is that the user must keep the original file.
- The flag is a decision rule, not a hypothesis test. It does not correct for multiple comparisons across criteria and judges, which the docs state.
- Small datasets rarely flag anything because the intervals are wide. That is intended.
- Only length is checked. Other style biases would need their own measures.
