/**
 * Canonical pull request URL classification - the single seam shared by prose
 * link derivation (deriveLinks), typed-link validation (`done --pr`, `add --pr`,
 * backend normalization), and public-followup `pr_url` deliverables.
 *
 * These byte-for-byte shapes are PR URLs:
 *   - GitHub:    https://<host>/<owner>/<repo>/pull/<n>
 *                (github.com or a GitHub Enterprise Server host)
 *   - Forgejo:   https://<host>/<owner>/<repo>/pulls/<n>
 *   - Bitbucket: https://<host>/<workspace>/<repo>/pull-requests/<n> (Cloud)
 *                https://<host>/projects|users/<key>/repos/<repo>/pull-requests/<n>
 *                (Data Center)
 * with <host> a lowercase DNS name and <n> a positive number without leading
 * zeros. Only the GitHub route is accepted on github.com. The route decides,
 * not the host, so self-hosted instances work. Anything else - issue URLs,
 * route confusion on github.com, trailing slash, query/fragment, whitespace,
 * userinfo, ports, encoded separators - is not a PR URL.
 */

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `(${HOST_LABEL}(?:\\.${HOST_LABEL})*)`;
const SEGMENT = "[A-Za-z0-9._-]+";
const NUMBER = "[1-9][0-9]*";
const PR_URL_RE = new RegExp(
  `^https://${HOST}/(${SEGMENT})/(${SEGMENT})/(pull|pulls|pull-requests)/${NUMBER}$`,
);
const BITBUCKET_DC_RE = new RegExp(
  `^https://${HOST}/(?:projects|users)/(${SEGMENT})/repos/(${SEGMENT})/pull-requests/${NUMBER}$`,
);

export const PR_URL_EXPECTED =
  "a canonical pull request URL: https://<host>/<owner>/<repo>/pull/<n> (GitHub), " +
  "https://<host>/<owner>/<repo>/pulls/<n> (Forgejo/Gitea), " +
  "https://<host>/<workspace>/<repo>/pull-requests/<n> or " +
  "https://<host>/projects|users/<key>/repos/<repo>/pull-requests/<n> (Bitbucket)";

function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/** True when url is byte-for-byte a canonical GitHub, Forgejo, or Bitbucket PR URL. */
export function isPrUrl(url: string): boolean {
  const m = PR_URL_RE.exec(url);
  if (m !== null) {
    const [, host, owner, repo, route] = m;
    if (isDotSegment(owner) || isDotSegment(repo)) return false;
    return route === "pull" || host !== "github.com";
  }
  const dc = BITBUCKET_DC_RE.exec(url);
  if (dc === null) return false;
  const [, host, key, repo] = dc;
  if (isDotSegment(key) || isDotSegment(repo)) return false;
  return host !== "github.com";
}
