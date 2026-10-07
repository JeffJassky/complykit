# From scan to verified install

This is the guided path through a consent fix: scan a site, tell complykit which
tools are which, get a checklist of exact changes, make them, check each one in
seconds, then rescan. It is written for a site owner and the developer who will
make the edits; you do not need to read code to follow it.

The detailed install steps (what the tool is, where the snippet goes, script
attributes, platforms) are in [Installing the consent tool](./consent-tool.md). This
page is the workflow around them: what to press, in what order, and what each
result does and does not tell you.

::: warning What this proves
Every result here is evidence about specific pages, seen from one connection, logged
out. None of it is a statement that a site complies with any law, and the word
"compliant" does not appear in any report. A **Verify** pass says the page we fetched
carries a change. Only the **rescan** at the end shows how the site behaved.
:::

The steps:

1. [Run the service locally](#_1-run-the-service-locally)
2. [Scan: the report page](#_2-scan-the-report-page)
3. [Classify the tools it does not know](#_3-classify-the-tools-it-does-not-know)
4. [Your to-do list is made for you](#_4-your-to-do-list-is-made-for-you)
5. [Read the to-do list](#_5-read-the-to-do-list)
6. [Download the install bundle and make the changes](#_6-download-the-install-bundle-and-make-the-changes)
7. [Verify each change](#_7-verify-each-change)
8. [Follow your progress](#_8-follow-your-progress)
9. [Run the final scan](#_9-run-the-final-scan)
10. [What stays out of reach](#_10-what-stays-out-of-reach)
11. [The same path from the command line](#_11-the-same-path-from-the-command-line)

## 1. Run the service locally

The checklist, **Verify** and **Rescan** buttons need the complykit service, a small
local web app that runs scans and keeps your work (classifications, checklist
progress) in one place per site. It runs on your own machine; nothing is sent to us.
If you only want files and a command line, skip to [step 11](#_11-the-same-path-from-the-command-line).

From a checkout of this repository, build the three parts, then start the service:

```sh
npm install && npm run build                         # the scanner (repo root)
(cd client && npm install && npm run build)          # the consent tool files, client/dist
(cd service && npm install && npm run build)         # the service and its web UI
DATA_DIR=./service-data node service/dist/server/index.js
```

Then open `http://localhost:8080`.

| Setting | What it does |
|---|---|
| `DATA_DIR` | Where the service keeps scans, site workspaces and generated configs. Pick a folder you will keep. Default: `service/.data`. |
| `PORT` | Default `8080`. |
| `COMPLYKIT_KB_DIR` | Where the tool knowledge base lives. Default: `<DATA_DIR>/kb`. Point it at an existing store to reuse tools you have already confirmed. |
| `COMPLYKIT_BROWSER_CHANNEL=chrome` | Use your installed Google Chrome. Set this when Playwright's own Chromium is not installed (the scans and the **Verify** browser checks both read it). Without either, they fail to start a browser. |
| `AUTO_CHECKLIST` | `0` turns off making the to-do list automatically when a scan finishes (the report page then offers **Make my to-do list**). Default: on. |
| `CONSENT_RUNS` | Visits per visitor choice when a scan opts into **Also repeat on a slow connection** (2 to 5, default 2). Other scans visit each choice once. |
| `COMPLYKIT_CLI`, `COMPLYKIT_CLIENT_DIST` | Only if you built into non-default places: the built `dist/cli.js`, and the `client/dist` folder the install bundle copies from. |

## 2. Scan: the report page

The home page has one field and one button: enter the site's address and press
**Scan**. (**Options** holds the rest: visitor privacy is on by default,
accessibility, a quick scan, and **Also repeat on a slow connection**, which visits
each choice again on a slowed connection to catch timing races and takes about three
times as long.) Below the field, **Your sites** lists each site with its latest
status; each links to its report page.

Pressing **Scan** opens the scan's report page at once. You can watch it fill in.
The page has four parts, in this order, and nothing else:

1. **Scan status**, only while the scan runs: how many visits are done of how many,
   pages visited, how long it has been going, the visit running now, a progress bar
   and **Cancel**.
2. **Consent banner**: "Consent banner: OneTrust" (the provider, when recognized),
   or "No consent banner detected" (naming a consent tool that loaded without showing
   one). Until the first visit finishes: "Looking for a consent banner…".
3. **Tools and cookies**: one row per tool the scan found, its cookies under it, and
   one column per visitor action ("Before a choice", "After rejection", "After
   acceptance", "Privacy signal (GPC)"…). New rows appear as visits find them. Each
   cell is a spinner while that visit is still to come, then **✓** (behaved as
   expected for its purpose), **✕** (running where it should be off: a behavior
   mismatch, not a legal verdict), **?** (needs your decision: what the tool is for),
   or **–** (not checked: the visit could not complete, for example no banner to
   reject; one line under the table says why, for the whole column). Select a cell to
   see what was expected and what the scan saw.
4. **Your to-do list** (steps 3 to 9 below).

At the bottom, **Technical details** opens the full report: the legal scope, every
finding with its evidence, the coverage and limits, and the compatibility table and
change list. Nothing is removed from it; it is simply off the main page. The
service's **Sites** page links each site to its latest report page too.

## 3. Classify the tools it does not know

The scan recognizes many vendors from its knowledge base. For anything it does not,
the first items of the to-do list ask what it is for: **Necessary**, **Functional**,
**Analytics** or **Advertising**. (The same choice opens when you select the tool's
row in the matrix.) That answer decides whether the tool needs consent, so it decides
what you will be asked to change. These questions appear while the scan is still
running, as soon as a visit finds the tool.

Your answer is saved with the site, shared by everyone who opens its report, and used
by every later report and scan. Once the scan has finished, the page re-renders the
report with your answers by itself (it waits a moment, so several answers in a row
make one update): the tool's row is judged, its cookies follow, and the changes that
depend on it are kept if the tool tracks visitors and dropped if it does not. Nothing
is rescanned, so it takes seconds. An answer given while the scan is running is
applied when it finishes.

## 4. Your to-do list is made for you

When a scan finishes, the service makes the site's consent tool config, the
paste-in snippet, the change list and the to-do list from it ("Preparing the changes
to make on your site…"), with your answers so far. There is no button to press.

One exception keeps your work safe: if you are already working an earlier scan's
list (something verified, marked done or failed), a new scan does not replace it,
because a new config would change the install you may have deployed. The new report
page then shows that list, with your progress, and says it comes from an earlier
scan. Each change has a stable id, so a change that is still needed keeps its status
whenever the list is remade.

If making the list fails, the page says why and offers **Try again**. With
`AUTO_CHECKLIST=0` the page offers **Make my to-do list** instead.

## 5. Read the to-do list

The list is one numbered list. Do it in order: the questions about tools the scan
does not know come first (their answers decide which changes apply, and what the
config in the install snippet says), then the install, which the rest rely on. Each
change has a short title ("Hold the Meta Pixel tag until consent"), a line on why,
and **How to do it**: numbered plain steps, the markup to paste with a **Copy**
button, the markup as it is now, and the pages it appears on. The change to do next
shows its steps open.

The order is: what each unrecognized tool is for; install the consent tool; remove
the existing consent tool, if the scan found one; fix any tool seen running where it
should be off; hold tags in the page; remove pixels that load on their own; gate tags
inside Google Tag Manager; platform settings; consent defaults; vendor calls, DNS and
decisions that stay; then confirmations in the browser. The last item is always
**Run the final scan**. A tag-manager item, a platform item and so on are described
in [Compatibility verdicts](./compatibility.md).

Each item shows one of these statuses:

| Status | Meaning |
|---|---|
| **To do** | Nothing recorded yet. |
| **Marked done** | You pressed **Mark done without checking** (or **I've done this** for a change with no automatic check). Not checked. It is counted apart from verified and never folded into it. |
| **Verified** | **Verify** ran and the check passed. See [step 7](#_7-verify-each-change) for exactly what that means. |
| **Failed** | **Verify** ran and the change is missing or wrong. The message says what it found. |
| **Can't verify automatically** | The check could not decide: the element is gone, the site served a bot challenge, or this kind of change has no automatic check. Never a pass. |
| **To decide** / **Decided** | Questions only: whether the site holds a purpose for that tool. Set by answering it, never by a button. |

**This also fixes.** A change can list others it fixes. For example, holding a tag
can also clear a "this tool ran after a refusal" finding for the same vendor, and
installing the tool covers a vendor's consent call. Those are folded into the one
change so you make it once; its Verify is its own check of that change.

**Waiting on.** A change whose tools are all unclassified names the question it waits
on and hides its buttons until you answer it. It still counts toward the total.

**Only if they apply.** Chat widgets, embeds and fonts sit in a folded list at the
end. They are not counted in the progress. Each says when it applies.

## 6. Download the install bundle and make the changes

On the install item (and on the site page), press **Download install bundle (.zip)**.
It contains the two tool files, the generated config, the snippet to paste first in
`<head>`, the change list and the checklist as Markdown. Put the two JavaScript files
in one folder on your own domain; the snippet's path is the one in the config (by
default `/complykit/v1/`, see [Installing the consent tool](./consent-tool.md#_1-what-you-get)).

Make the install change and the "remove the existing consent tool" change in the same
deploy: two tools writing the choice is worse than none. Then make each change in the
order given. If you are the owner and not the developer, hand over the bundle and the
checklist; the steps are written to be followed without further explanation.

## 7. Verify each change

After deploying a change, press **Verify** on that item. It checks one thing in
seconds, with no full scan, and records the result with the time and the evidence
(the element or setting it looked at). Press **Verify again** after fixing.

There are two kinds of check.

**Static checks** fetch the page the change is on (or, for Google Tag Manager, the
published container file) and read it. They cover installing the tool (one config
element, valid and matching the latest generated one, the script not async or
deferred, and first in `<head>`), removing the old tool, holding a tag (no copy runs
unheld, and a held copy with the right category), removing a pixel, a consent default,
and gating a GTM tag.

**Browser checks** open one page twice, once refusing and once accepting, through the
installed tool. They cover changes that only show in behavior: a platform setting, a
vendor's consent call, a tag manager's setting. A pass needs the vendor to be **silent
after the refusal and active after the accept**. A vendor that never appears proves
nothing, so it reads as "can't verify".

What a pass means, and what it does not:

- A static pass means **the HTML we fetched carries the change**. It cannot see a
  script that later releases a held tag, a different version served from a CDN, a
  container republished afterward, a server that forwards data on its own, or any page
  other than the one fetched. (A change seen on several pages is checked on the one it
  was found on.)
- A browser pass means **one page, one visit, one vendor behaved**. It is not a scan.
- A **GTM** check reads the published container only. Changes sitting in a draft
  workspace or in GTM's preview are invisible, so publish before you press Verify.
- Neither kind is the rescan. Each pass says so.

**Bot challenges.** If the site answers with a bot-protection page instead of its own
(Cloudflare, Akamai, PerimeterX, DataDome, Sucuri and Imperva are recognized), the
result is "can't verify automatically: the site served a bot challenge instead of the
page". No change is judged against a challenge page. Allow the service's address
through, or turn the challenge off for the check, and press Verify again.

**Changes that can't be checked automatically.** DNS changes, decisions to keep an
exposure, and items with no element to find have no check. They show "Can't be checked
automatically" and no Verify button. Make the change, press **I've done this**,
and the rescan decides. An item you marked is shown as "Marked done", apart from
verified; pressing the button again undoes it.

## 8. Follow your progress

The to-do list's header reads, for example, "3 of 9 done". "Done" counts verified
changes, answered questions and changes you marked done; the item itself still shows
**Marked done** apart from **Verified**. The **Sites** page and the home page's site
list show the same counts per site. Items under "Only if they apply" are never
counted.

## 9. Run the final scan

The last item, **Run the final scan**, opens up when every required item is verified,
decided or marked done, including the install. It starts a new scan of the site with
the options of its latest scan, from the service's own connection (the only place it
scans from today), and opens that scan's report page, which fills in as before. A site
can run only one scan at a time; if one is already running, the button says so. If
the scan fails or is cancelled, nothing on the list changes and you can start it again.

The final scan's matrix shows, per tool and visitor action, whether each tool now
behaves. Its full report (**Technical details**) has the section **"Your complykit
consent tool: what it controls"**, the per-vendor proof.

### Reading "what it controls"

The section opens with one line, for example "complykit consent tool detected:
version 0.1.0, config generated 6 Oct 2026: 3 vendors controlled, 2 not (GA4, session
recording), 6 not observed". It always ends with its scope: how many pages, how many
locations, logged out, how many runs. Then one row per vendor with one of three
results:

| Result | Meaning |
|---|---|
| **Controlled** | Held in every visit where your config denies it, seen running when granted, and consistent across the journey. Evidence for these pages and this location. |
| **Not controlled** | Seen running where the config says it must be off: after a refusal, under Global Privacy Control, after a withdrawal. The row names the visit and the request or cookie. Fix these first. |
| **Not observed** | The scan has no proof either way: the vendor never appeared, or never in a state that tests the claim. **This is not a pass** and is never counted as controlled. |

Anything on the checklist that you did not verify or mark done shows up here as a
vendor still running when it should not. A change that had passed Verify and now shows
"not controlled" means the page we fetched carries the change but the browser still
sees the vendor; the row says where. Both
[Reading what stays red](./consent-tool.md#reading-what-stays-red) and the list of
findings in [the install guide](./consent-tool.md#the-consent-tool-detected-section)
explain the common causes.

## 10. What stays out of reach

These cannot be fixed or proven by this workflow, and the report says so:

- **Server-side.** A tag your server or a platform forwards to a vendor never passes
  through the browser. A consent tool cannot hold it, and a scan cannot see it.
- **Vendor-side.** What a vendor does with data it has already received, or keeps
  collecting under its own settings.
- **Pages and states not visited.** Logged-in areas, checkout, anything the scan did
  not reach. "Not observed" is the report saying so.
- **Other places.** The scan runs from one location. The EU and UK are not checked
  until verified exits exist ([CLI: `--locations`](/reference/cli#consent)), so a
  result is about where the scan ran, not about every visitor. A site that behaves
  differently by location is not shown to be fine elsewhere.
- **Anything after the scan.** A later release, an A/B variant or a changed container
  can undo a verified change. Rescan after changes to the site.

See [What a scan cannot tell you](./limits.md).

## 11. The same path from the command line

Everything above is also available without the service, with files in place of
buttons:

```sh
# 1. scan
complykit consent --url https://www.example-shop.test

# 2. re-render with your classifications (a workspace.json of them), in seconds
complykit report --run <run-id> --format consent-html --workspace workspace.json --out report.html

# 3. the config, snippet, change list and notes (add --json to print the checklist tasks)
complykit consent-config .comply/runs/<run-id> --workspace workspace.json

# 4. after deploying a change, check one task (task.json = one object from the "tasks" array of step 3's --json output)
complykit verify-change --task task.json --json

# 5. rescan with the workspace so the scan knows your config
complykit consent --url https://www.example-shop.test --workspace workspace.json
```

Without the service there are no buttons, so progress is not kept for you: mark things
off in `checklist.md` yourself. `verify-change` prints `pass`, `fail` or
`cannot-verify` with evidence and exits 0 for any of them (2 for bad input). Options
are in the [CLI reference](/reference/cli#verify-change).

## See also

- [Installing the consent tool](./consent-tool.md): the install in full
- [Compatibility verdicts and the change list](./compatibility.md)
- [Setting up Google Tag Manager](./gtm-setup.md)
- [What a scan cannot tell you](./limits.md)
- [CLI reference](/reference/cli)
