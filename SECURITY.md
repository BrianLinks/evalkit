# Security

## Reporting a vulnerability
Use GitHub's private vulnerability reporting (Security tab, "Report a vulnerability") on this repository. Please do not open a public issue for security problems.

## Design notes
- API keys are read from environment variables only. They are not stored in run files and are excluded from error messages.
- Dataset text is untrusted. It is fenced inside tags in the judge prompt and the judge is told to treat it as data. This reduces prompt injection but cannot remove it, so treat judge scores for adversarial inputs with care.
- Run ids are validated against a strict pattern before use in file paths.
- EvalKit never evaluates code from rubrics or datasets.
