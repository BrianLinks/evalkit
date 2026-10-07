# 0005: Pairwise judging shows both orders

Status: accepted

## Context
LLM judges are known to favour one position in a pair, often the first. If each pair is judged once, that bias is mixed into the win rate and cannot be seen.

## Decision
Every judge sees every (pair, criterion) twice, with A first and then with B first. Each verdict is mapped back to system A, system B or tie. If the two orders agree, that is the verdict. If they disagree, the verdict is a tie and the pair is counted as a flip. The report also shows how often a judge picks whichever response it saw first.

## Consequences
- Pairwise runs cost twice as many calls.
- Consistency and first-pick rate expose position bias per judge, so an unreliable judge can be spotted and dropped.
- Win rates are computed from decisive pairs only, with a Wilson interval, so a small number of decisive pairs shows up as a wide interval rather than a confident number.
- Only two systems are compared. Ranking more systems would need a different model (for example Bradley-Terry) and is out of scope for now.
