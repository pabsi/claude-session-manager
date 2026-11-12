# Security policy

## Supported versions

There are no releases. Only the latest commit on `main`, and the site deployed from it at
<https://pabsi.github.io/claude-session-manager/>, get security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/pabsi/claude-session-manager/security/advisories/new)**
(Security tab → Advisories → Report a vulnerability).

Please don't open a public issue or pull request for a vulnerability until a fix is out.

Include what you can of:

- what an attacker can do, and what they need first (e.g. "a website the user visits can …")
- steps to reproduce, or a proof of concept
- the mode affected: `serve.py`, or the browser-only page; and the OS and browser
- the commit you tested

This is a personal project maintained in spare time, so responses are best effort. You'll
get an acknowledgement, and credit in the advisory if you'd like it.

## Scope

The app reads and changes Claude Code transcripts on the user's own computer, so the
issues that matter most are ones that let **someone other than the user** read, change or
delete those files, or run code. For example:

- a website, or another origin, reading transcripts or triggering trash, restore or delete
  through `serve.py` (it binds to `127.0.0.1`, checks the `Host` header and requires an
  `X-CSM: 1` header on mutating calls; see the README's Security section)
- path traversal or reading files outside `~/.claude` and `static/`
- script injection (XSS) through transcript content in the side panel or in an HTML export
- the browser-only page sending data anywhere other than its own origin
- a compromised dependency or GitHub Actions workflow publishing a malicious site

Out of scope:

- attacks that already need access to the user's account or files on their computer
- the user deleting their own sessions through the UI
- claude.ai, Claude Code and GitHub themselves; report those to
  [Anthropic](https://www.anthropic.com/responsible-disclosure-policy) or
  [GitHub](https://bounty.github.com/)
