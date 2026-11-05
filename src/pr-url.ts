/**
 * Canonical pull request URL classification - the single seam shared by prose
 * link derivation (deriveLinks), typed-link validation (`done --pr`, `add --pr`,
 * backend normalization), and public-followup `pr_url` deliverables.
 *
 * Exactly two byte-for-byte shapes are PR URLs:
 *   - GitHub (github.com and any GitHub Enterprise host):
 *     https://<lowercase-dns-host>/<owner>/<repo>/pull/<n>
 *   - Forgejo (any host other than github.com):
 *     https://<lowercase-dns-host>/<owner>/<repo>/pulls/<n>
 * with <n> a positive number without leading zeros. Anything else - issue URLs,
 * `/pulls/` on github.com, trailing slash, query/fragment, whitespace, userinfo,
 * ports, encoded separators - is not a PR URL.
 */

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SEGMENT = "[A-Za-z0-9._-]+";
const PR_URL_RE = new RegExp(
  `^https://(${HOST_LABEL}(?:\\.${HOST_LABEL})*)/(${SEGMENT})/(${SEGMENT})/(pull|pulls)/([1-9][0-9]*)$`,
);

export const PR_URL_EXPECTED =
  "a canonical pull request URL: https://<host>/<owner>/<repo>/pull/<n> (GitHub, including GitHub Enterprise hosts) or https://<host>/<owner>/<repo>/pulls/<n> (Forgejo)";

/**
 * True when url is byte-for-byte a canonical GitHub (incl. GitHub Enterprise)
 * or Forgejo PR URL.
 */
export function isPrUrl(url: string): boolean {
  const m = PR_URL_RE.exec(url);
  if (m === null) return false;
  const [, host, owner, repo, route] = m;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return false;
  }
  // `/pull/<n>` is GitHub's shape on github.com and on GitHub Enterprise hosts
  // (ghe.com, GHES); `/pulls/<n>` stays Forgejo-only, so github.com keeps
  // rejecting it.
  return route === "pull" || host !== "github.com";
}
