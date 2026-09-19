# security skill
description: security review and hardening workflow

instructions: |
  threat-model the change: injection, auth bypass, SSRF, path traversal,
  secret leakage, dependency risk (audit_deps), overly broad permissions
  never log or persist secrets; check .env and config handling
  prefer allowlists over denylists; validate all external input
  report findings with severity + concrete fix, referencing exact files/lines
