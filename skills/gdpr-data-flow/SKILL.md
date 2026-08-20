---
name: gdpr-data-flow
description: Investigate a codebase's handling of personal data for GDPR — what personal data is collected, where it flows, whether erasure (Art. 17) is actually possible, and which third parties receive it. Use when the property is tagged processes-personal-data + targets-eu, after complykit's PII/tracker inventories scope the surface.
---

# GDPR data-flow review

This is the investigative (C2) counterpart to complykit's deterministic layers.
It needs reasoning over composition and data flow — a codebase exploration, not
AST pattern-matching. complykit's PII and tracker inventories are your scoping
input; this skill traces what they found.

## Step 1 — map the personal data (from the inventories + models)

- Start from the PII-surface inventory (schema fields matching personal-data
  patterns). For each, confirm it is genuinely personal data in context.
- For each personal-data field, trace: where is it **collected** (forms, APIs),
  where is it **stored**, where is it **sent** (third-party APIs, analytics,
  logs)?

## Step 2 — the load-bearing questions

1. **Erasure (Art. 17).** Is there a code path that actually deletes a user's
   personal data on request — including denormalised copies, caches, logs, and
   third-party mirrors? A "delete account" that only flips a flag does not
   satisfy erasure. Trace the delete path and note every store it does *not*
   reach.
2. **Third-party sharing (Art. 13/14 + Art. 44 transfers).** Cross-reference the
   tracker/SDK inventory: which recipients get personal data, for what purpose,
   and are they disclosed in the privacy notice? Flag any egress to a processor
   not covered by the notice.
3. **Lawful basis / minimisation.** Is personal data collected that the feature
   does not need? Note obvious over-collection.

## Step 3 — record findings

```bash
complykit finding add --run <runId> --producer agent --model <you> \
  --json '{"ruleId":"gdpr.data-flow","requirementId":"gdpr.art13","subject":{"property":"<id>","file":{"path":"src/models/user.ts","line":42}},"confidence":"needs-review","message":"User email is forwarded to a third-party CRM not named in the privacy notice.","evidence":[]}'
```

- Cite the specific article (`gdpr.art13`, `gdpr.art17`, …).
- Erasure gaps and undisclosed transfers are usually `needs-review` — they turn
  on facts (DPAs, notices) outside the code. Say what you could and could not
  confirm.

## Do not

- Do not connect to production data stores (complykit's standing rule: no DB /
  `.env` access). Reason from the repo and the rendered site only.
- Do not conclude "GDPR compliant"; record evidence against specific articles.
