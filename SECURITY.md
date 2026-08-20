# Security Policy

## Supported versions

| Project version | DeepSeek Harness | Support level               |
| --------------- | ---------------- | --------------------------- |
| `0.1.0-alpha.5` | `0.1.0-rc.8`     | Public Preview, best effort |
| `0.1.0-alpha.4` | `0.1.0-rc.7`     | Public Preview, best effort |

Untagged commits and locally built packages have no support lifetime or compatibility promise.

## Reporting a vulnerability

Do not report an undisclosed vulnerability through a public issue, pull request, or discussion. Use GitHub private vulnerability reporting:

https://github.com/songyang0603/dsh-open-deep-research/security/advisories/new

Include the affected version or commit, reproduction steps, expected impact, and relevant sanitized configuration. Remove credentials, tokens, cookies, private or signed URLs, session data, and personal information from submitted material.

## Scope

Report project-owned security behavior here, including:

- credential handling and accidental secret exposure;
- generated Profile or package contents;
- research Tool isolation and unexpected capability exposure;
- unsafe URL handling introduced by this package;
- lifecycle behavior that leaves package-owned Agents or processes running;
- vulnerabilities in this package's public API, initializer, or one-shot app.

Vulnerabilities in DeepSeek Harness, Jina Reader, or another dependency should be reported to that upstream project. A package-level integration flaw or unsafe default remains in scope here even when an upstream component participates in the failure.

## Response expectations

The public Alpha has no vulnerability bounty and no guaranteed response or remediation SLA. The maintainer will acknowledge valid reports through GitHub private vulnerability reporting and coordinate disclosure timing before publishing sensitive details.
