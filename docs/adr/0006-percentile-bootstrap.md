# 0006: Percentile bootstrap over samples

Status: accepted

## Context
Kappa, Spearman and Krippendorff's alpha come with no standard error that is easy to compute and valid for these small, discrete, ordinal datasets. A single point estimate from 8 or 30 samples can look more certain than it is. We want an interval that works for every statistic with one mechanism.

## Decision
Use a percentile bootstrap. Resample whole samples (all raters' scores for a sample together) with replacement, recompute the statistic, and take the tail percentiles. Seed a small in-house generator (mulberry32) because `Math.random` cannot be seeded, and an external dependency is not worth it for 10 lines. Drop resamples where the statistic is undefined, but return `null` instead of an interval if more than half are undefined. Make it opt-in with `--bootstrap`, so default reports stay short and cheap.

## Consequences
- One mechanism covers kappa, rho and alpha, including alpha with missing ratings.
- Reports are reproducible: same data, iterations and seed give the same interval.
- Percentile intervals are not bias-corrected and can be too narrow at very small n. BCa intervals would fix some of that and are a possible later step. The report says to treat intervals as rough under about 20 samples.
- Cost is linear in resamples. Spearman ranks small-integer ratings by counting rather than sorting, which made it roughly 7 times faster and the bootstrap about 3 times faster overall.
- Resampling samples assumes samples are independent. If the dataset has several rows from the same prompt or author, the interval will be too narrow.
