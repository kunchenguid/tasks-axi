/**
 * Canonical pull request URL classification - the single seam shared by prose
 * link derivation (deriveLinks), typed-link validation (`done --pr`, `add --pr`,
 * backend normalization), and public-followup `pr_url` deliverables.
 *
 * Exactly three byte-for-byte shapes are PR URLs:
 *   - GitHub:  https://github.com/<owner>/<repo>/pull/<n>
 *   - Forgejo: https://<lowercase-dns-host>/<owner>/<repo>/pulls/<n>
 *   - GitLab:  https://<lowercase-dns-host>/<namespace>/<project>/-/merge_requests/<n>
 *     where <namespace> may nest (group/subgroup) and any host is accepted
 *     (gitlab.com or self-hosted).
 * with <n> a positive number without leading zeros. Anything else - issue URLs,
 * singular/plural route confusion, trailing slash, query/fragment, whitespace,
 * userinfo, ports, encoded separators - is not a PR URL.
 */

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`;
const SEGMENT = "[A-Za-z0-9._-]+";
const NUMBER = "[1-9][0-9]*";
const PR_URL_RE = new RegExp(
  `^https://(${HOST})/(${SEGMENT})/(${SEGMENT})/(pull|pulls)/${NUMBER}$`,
);
const GITLAB_MR_URL_RE = new RegExp(
  `^https://${HOST}/((?:${SEGMENT}/)+${SEGMENT})/-/merge_requests/${NUMBER}$`,
);

export const PR_URL_EXPECTED =
  "a canonical pull request URL: https://github.com/<owner>/<repo>/pull/<n> (GitHub), https://<host>/<owner>/<repo>/pulls/<n> (Forgejo), or https://<host>/<namespace>/<project>/-/merge_requests/<n> (GitLab)";

/** A path segment that names a repo, owner, or namespace (not `.`, `..`, or the GitLab `-` route separator). */
function isNameSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && segment !== "-";
}

/** True when url is byte-for-byte a canonical GitHub, Forgejo, or GitLab PR URL. */
export function isPrUrl(url: string): boolean {
  const gl = GITLAB_MR_URL_RE.exec(url);
  if (gl !== null) return gl[1].split("/").every(isNameSegment);
  const m = PR_URL_RE.exec(url);
  if (m === null) return false;
  const [, host, owner, repo, route] = m;
  if (!isNameSegment(owner) || !isNameSegment(repo)) return false;
  return route === "pull" ? host === "github.com" : host !== "github.com";
}
