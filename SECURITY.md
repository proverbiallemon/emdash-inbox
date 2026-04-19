# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in emdash-inbox, please **do not** open a public GitHub issue.

Instead, report it privately via a [GitHub security advisory](https://github.com/proverbiallemon/emdash-inbox/security/advisories/new) on the repository.

Please include:

- A description of the issue and its potential impact
- Steps to reproduce (proof-of-concept, affected endpoints, sample payloads)
- Your suggested remediation, if any

You can expect an initial response within a few business days.

## Scope

In scope:

- The emdash-inbox plugin source
- Deployment templates shipped with this repo

Out of scope:

- Vulnerabilities in upstream dependencies — report to the respective projects
- Vulnerabilities in EmDash itself — report to [emdash-cms/emdash](https://github.com/emdash-cms/emdash)
- Misconfiguration of a self-hosted instance (exposed secrets, missing capability declarations, etc.)

## Supported Versions

emdash-inbox is pre-alpha. Security fixes land on `main`. A supported-versions table will be added once we reach v1.0.
