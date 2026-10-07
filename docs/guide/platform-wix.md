# Installing on Wix

Wix injects some tracking itself (pixels added from the dashboard's Marketing
Integrations, Wix Analytics, Google Tag Manager added there). The tool cannot
hold back a script Wix injects, so it tells Wix what the visitor chose through
Wix's own **consent policy**, and Wix's scripts read it. Your config needs
`"platform": "wix"` ([config](/guide/config)); the bridge also switches itself
on if it finds the Wix API on the page.

## Install

1. In the Wix dashboard open **Settings > Custom Code** and choose **Add Custom
   Code**.
2. Paste the consent tool snippet (the config element and the script).
3. Set **Add Code to Pages** to **All pages**, **Load code once** off, and
   **Place Code in** to **Head**.
4. Save. Put this entry **above** every other custom-code entry (drag it to the
   top of the list). Anything above it can run before the tool does.
5. Turn **off** Wix's own cookie banner (**Settings > Cookie Banner**, or the
   Privacy and cookies settings, depending on your Wix version). Two banners
   write the same policy and fight. If Wix's banner grants something the visitor
   denied in ours, the bridge sets it back (up to five times) and records it in
   `ComplyKit.diagnostics.wix`; it will not win that fight forever.
6. Set Wix's **site default consent policy** to deny functional, analytics,
   advertising and data transfer for visitors who must opt in (see the limit
   below).

Third-party scripts you paste into Custom Code are not Wix-injected: those are
the script gate's job, so mark them as the change list says.

## How the fields map

The tool calls `consentPolicyManager.setConsentPolicy` with all four fields, on
the first decision and on every change:

| Wix field | True only when the tool category is granted |
|---|---|
| `essential` | always true (Wix forces it) |
| `functional` | `functional` |
| `analytics` | `analytics` |
| `advertising` | `advertising` |
| `dataToThirdParty` | `advertising` |

A category the config does not list counts as denied. Wix field names and the
manager's methods are documented by Wix:
[Consent Policy Manager](https://dev.wix.com/docs/sdk/host-modules/site/consent-policy-manager/set-consent-policy),
[manage cookie consent](https://dev.wix.com/docs/go-headless/wix-managed-headless/full-integration-astro/feature-guides/manage-cookie-consent).
The `dataToThirdParty` mapping is our choice: Wix describes it only as data
transfer to third parties (CCPA). Override the map per site if yours differs
(`installWixBridge(config, store, { map: { dataToThirdParty: ['advertising', 'analytics'] } })`).

## What this cannot guarantee

- **The first page view.** Wix documents that a policy change takes effect after
  the page is refreshed, and that `setConsentPolicy` is persisted through a
  network request. A Wix script that already ran on this view may have seen the
  old policy. That is why step 6 matters: on a new Wix site the default policy
  grants every category, so a first-time visitor in an opt-in region gets
  tracking before they choose unless the site default is restrictive. The tool
  does not reload the page for the visitor.
- **A withdrawal on the same view.** Revoking updates the stored policy at once,
  but scripts already running keep running until the next page load.
- **Which Wix script honours which field.** Wix does not document that per
  script. We rely on the field names only. The proof scan (loading the site
  after a Reject) is what shows whether the pixels actually stopped.
- **The Wix API missing.** If `consentPolicyManager` does not appear within 15
  seconds the choice is **not** sent, and `ComplyKit.diagnostics.wix.gaveUp` is
  true. Nothing is reported as compliant on that basis.
