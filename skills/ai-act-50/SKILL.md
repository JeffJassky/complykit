---
name: ai-act-50
description: Investigate EU AI Act Article 50 transparency obligations for a codebase and its rendered product — whether users are told they are interacting with an AI system, and whether AI-generated content is marked. Use when complykit derived a has-ai-features signal, or the property is tagged has-ai-features.
---

# EU AI Act Article 50 review

Article 50 (enforceable from 2 Aug 2026) requires that people be **informed when
they interact with an AI system** (Art. 50(1)) and that **AI-generated synthetic
content be marked** as artificial (Art. 50(2)), unless obvious from the
circumstances. This is verified-greenfield — no off-the-shelf tool checks it
against a rendered product. This skill scopes and records the obligation.

## Step 1 — inventory the AI surface (from the repo)

complykit's static layer already inventoried AI frameworks (`@anthropic-ai/*`,
`openai`, `langchain`, …). Start there, then in the code determine for each:

- Is the AI output or interaction **user-facing** (a chat, assistant, generator,
  recommendation shown to a person)? Internal tooling with no user-facing output
  is out of scope — dispose as not-applicable.
- What does the user **see** at the point of interaction?

## Step 2 — check the disclosures (from the rendered pages)

For each user-facing AI feature, using the run's screenshots + DOM captures:

- **Art. 50(1):** is there a clear, visible notice that this is an AI system — a
  chat header, a first-message disclosure, a labelled "AI assistant"? A
  reasonable user must not believe they are talking to a human. Obvious contexts
  (a clearly branded bot) satisfy it.
- **Art. 50(2):** for AI-*generated* media/text shown to users, is the output
  marked (visible label and/or machine-readable marking per the Code of
  Practice)?

## Step 3 — record findings

```bash
complykit finding add --run <runId> --producer agent --model <you> \
  --json '{"ruleId":"art50.ai-interaction-disclosure","requirementId":"eu-ai-act.art50.1","subject":{"property":"<id>","routePattern":"/assistant"},"confidence":"needs-review","message":"The assistant gives no notice that it is an AI system.","evidence":[]}'
```

- Cite `eu-ai-act.art50.1` (interaction) or `eu-ai-act.art50.2` (content marking).
- These requirements are `volatile` — guidance is still settling; note the date
  and the guideline version you relied on.

## Do not

- Do not give a legal conclusion. Record the evidence and the specific article.
- Do not fire Art. 50 on a property with no user-facing AI — scope it out.
