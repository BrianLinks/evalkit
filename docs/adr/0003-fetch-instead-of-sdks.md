# 0003: Plain fetch instead of provider SDKs

Status: accepted

## Context
Judges only need one request type per provider. SDKs add dependencies, version churn and behaviour that is hard to fake in tests.

## Decision
Call the Anthropic Messages API and the OpenAI Chat Completions API with `fetch` through one small retrying helper. Validate the response shape with zod.

## Consequences
- The only runtime dependency is zod.
- Tests inject a fake `fetch` and check the exact URL, headers and body.
- We own retry and timeout behaviour (retry on network errors, 429 and 5xx with exponential backoff; fail fast on other 4xx).
- If a provider changes its wire format, we update it ourselves.
