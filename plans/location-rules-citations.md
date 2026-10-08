# Location rules — state citation check

**For human confirmation — not yet applied to the registry.** No citation or URL in
`src/registry/` was changed; only the `verified` / `botBlocked` fields on
`src/registry/us-states.ts` URLs were set. Checked 2026-10-08 by fetching each URL and,
for PDFs, extracting the text locally.

For each state in `US_PRIVACY_ACT_STATES`: the section that grants the right to opt out of
targeted advertising / sale (**Right**) and the section that requires a clear and
conspicuous method or disclosure (**Method**). Quotes are under 15 words.
"Could not confirm" means the registry URL did not give readable text for that point.

## URL status

| Status | States |
|---|---|
| Verified (loads, right law) | CA*, VA, CT, DE, NE, NH, MD, OR, MT, RI, IA, KY, AL, OK |
| Bot-blocked | CO (empty response), NJ (Incapsula block page) |
| Dead (HTTP 404) | MN (`/statutes/cite/325O`), TN (AG page) |
| Loads but not the law, or no readable text | UT and TX (script-rendered, no statute text), IN (returns an HTML shell, not the PDF), LA and VT (site home pages only) |

Also: `tracking.ts` `us-states.opt-out-signal` cites
`https://cppa.ca.gov/meetings/materials/20260806_07_02.pdf`. It loads and is a CPPA
informational session on opt-out preference signals ("at least a dozen states"); it is not a
list of states with dates. `us-states.opt-out-method` cites the Virginia chapter URL, which
is verified (VA below).

Redirects (URL still resolves, registry may want the new host): Montana `leg.mt.gov` to
`mca.legmt.gov`; New Hampshire `www.gencourt.state.nh.us` to `gc.nh.gov`.

\* CA: the file named `ccpa_statute_eff_20260101.pdf` contains the **regulations** (Title 11,
CCR, effective 1/1/2026), not the Civil Code statute. Right law family, wrong document for
a statute citation. Statute sections are 1798.120 (right to opt out) and 1798.135 (link).

## Per state

| State | Right | Method |
|---|---|---|
| CA | Cal. Civ. Code §1798.120 (named in the regs' authority notes; statute text not in the registry URL). Could not confirm quote. | Civ. Code §1798.135(a); 11 CCR §7013, §7015, §7026 (listed in the registry URL's table of contents). Could not confirm quote. |
| CO | Could not confirm (page not retrievable). | Could not confirm (page not retrievable). |
| CT | Conn. Gen. Stat. §42-518(a)(5): "opt out of the processing of the personal data for purposes of" targeted advertising, sale. https://www.cga.ct.gov/current/pub/chap_743jj.htm | §42-520: "Providing a clear and conspicuous link on the controller's Internet web site". Same URL. |
| DE | 6 Del. C. §12D-104(a)(6): "Opt out of the processing of the personal data". https://delcode.delaware.gov/title6/c012d/index.html | §12D-106: "clearly and conspicuously disclose such processing". Same URL. |
| IA | Iowa Code §715D.3(1)(d): "To opt out of the sale of personal data." (sale only; no targeted-advertising opt-out in the text read). https://www.legis.iowa.gov/docs/code/715D.pdf | §715D.4: "shall clearly and conspicuously disclose such activity". Same URL. |
| MD | Could not confirm the section (the URL is §14-4707, duties; the opt-out right is in a different section). | §14-4707(f)(3)(i): "Providing a clear and conspicuous link on the controller's website". https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4707&enactments=false |
| MN | Could not confirm (registry URL is 404; the chapter number may be wrong: the site shows a consumer data privacy part under ch. 325M). | Could not confirm. |
| MT | Could not confirm text. The index (https://mca.legmt.gov/bills/mca/title_0300/chapter_0140/part_0280/sections_index.html) lists 30-14-2808 "Consumer personal data" rights. | Could not confirm text. Index lists 30-14-2811 "Duties of controllers". |
| NE | Could not confirm. The URL is only §87-1101 ("Act, how cited"; the act is §§87-1101 to 87-1130). | Could not confirm. |
| NH | RSA 507-H:4, I(e): "Opt-out of the processing of the personal data for purposes of targeted advertising". https://gc.nh.gov/rsa/html/LII/507-H/507-H-mrg.htm | RSA 507-H:6, V(a)(1)(A): "a clear and conspicuous link on the controller's Internet website". Same URL. |
| NJ | Could not confirm (page blocked). | Could not confirm (page blocked). |
| OR | Could not confirm the section. The AG page paraphrases the right: "You can Opt-out (say "no")". https://www.doj.state.or.us/consumer-protection/id-theft-data-breaches/privacy/ | Could not confirm the section. Page says businesses need "a clear and conspicuous link on their websites" (paraphrase). Same URL. |
| TN | Could not confirm (registry URL is 404). | Could not confirm. |
| TX | Could not confirm (page is script-rendered). Expected Bus. & Com. Code §541.051. | Could not confirm. Expected §541.102 / §541.055. |
| UT | Could not confirm (page is script-rendered). Expected Utah Code §13-61-201. | Could not confirm. Expected §13-61-302. |
| VA | Va. Code §59.1-577(A)(5): "To opt out of the processing of the personal data for purposes of" targeted advertising, sale. https://law.lis.virginia.gov/vacode/title59.1/chapter53/ (full text at `/vacodefull/title59.1/chapter53/`) | §59.1-578(D): "shall clearly and conspicuously disclose such processing". Same chapter. |
| IN | Could not confirm (the URL returns an HTML shell, not the bill). Expected IC 24-15-3-1. | Could not confirm. Expected IC 24-15-4. |
| KY | Acts ch. 72 (HB 15) §3(1)(e): "Opt out of the processing of personal data for purposes of targeted advertising". https://apps.legislature.ky.gov/law/acts/24RS/documents/0072.pdf | §4: "shall clearly and conspicuously disclose such activity". Same URL. |
| RI | Could not confirm. The URL is §6-48.1-4 (processing duties, consent revocation); no targeted-advertising opt-out text was found in it. | Could not confirm. |
| OK | SB 546 (2025) §2(5): "Opt out of the processing of the personal data for purposes of" targeted advertising, sale. https://www.oklegislature.gov/cf_pdf/2025-26%20ENR/SB/SB546%20ENR.PDF | SB 546 §8: "shall clearly and conspicuously disclose on the notice". Same URL. |
| LA | Could not confirm (the URL is the legislature home page, not SB 386). | Could not confirm. |
| AL | HB 351 (2026) §5(a)(5): "Opt out of the processing of the consumer's personal data". https://alison.legislature.state.al.us/files/pdf/SearchableInstruments/2026RS/HB351-enr.pdf | HB 351 §6(b): "providing a clear and conspicuous link on the controller's Internet website". §7: disclosure of the opt-out manner. Same URL. |
| VT | Could not confirm (the URL is the legislature home page, not S.71). | Could not confirm. |

## For a human to do

- Replace or fix: MN (404, check chapter number), TN (404), LA and VT (home pages), IN (not a PDF), CA (regulations, not statute).
- Retrieve in a normal browser: CO, NJ, TX, UT, OR section numbers, MT section text, NE sections 87-1102 onward, RI opt-out section, MD opt-out right section.
- Decide whether to move to section-level URLs for the states above.
