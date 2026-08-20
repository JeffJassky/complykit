---
name: policy-drift
description: Reconcile a property's stated privacy policy / cookie notice against its observed runtime behaviour — cookies set, trackers loaded, and consent flow captured by complykit — and flag where the text and the behaviour disagree. Use after a browser scan with consent evidence, when a privacy/terms document is available.
---

# Policy-vs-behaviour drift review

A privacy policy is a set of claims; complykit's evidence pass is what the site
actually does. Drift between them is a finding a regulator cares about — and one
no purely-deterministic tool can judge, because it requires reading prose against
observed behaviour. Verified-greenfield.

## Inputs

- The property's **privacy policy / cookie notice** text (config `policies`).
- The run's **consent evidence** in `.comply/runs/<id>/evidence/`: pre-consent /
  post-reject / post-accept cookie captures and network logs, and the
  consent-flow artifact (click counts, button metrics).

## What to reconcile

1. **Cookies claimed vs cookies set.** Does the notice enumerate the cookies /
   categories actually observed pre- and post-consent? Flag cookies set that the
   notice does not mention, and categories the notice claims are gated that fire
   before consent.
2. **Third parties claimed vs contacted.** Compare the recipients named in the
   policy to the initiator-attributed network requests. Flag undisclosed
   recipients.
3. **Consent claims vs consent flow.** If the policy says users can refuse
   non-essential cookies "as easily as accept", does the captured flow bear that
   out (reject present, equal prominence, equal clicks)? complykit's
   `consent.click-asymmetry` already flags the mechanics; this skill checks them
   against the written promise.
4. **Retention / rights claims.** Note claims the evidence can neither confirm nor
   deny (retention periods, DSAR handling) — they belong in the manual slice.

## Record findings

```bash
complykit finding add --run <runId> --producer agent --model <you> \
  --json '{"ruleId":"policy.drift","requirementId":"gdpr.art13","subject":{"property":"<id>","routePattern":"/"},"confidence":"needs-review","message":"The notice claims no advertising cookies before consent, but _fbp is set pre-consent.","evidence":[]}'
```

- Cite the article the drift implicates (usually `gdpr.art13` for disclosure,
  `gdpr.art7.3/7.4` for consent).
- Quote the policy line and the observed behaviour in the message so the drift is
  self-evident.

## Do not

- Do not paraphrase the policy as fact; quote it and set it against evidence.
- Do not declare conformance — record the drift and the evidence.
