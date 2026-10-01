/**
 * Canonical pull request URL classification - the single seam shared by prose
 * link derivation (deriveLinks), typed-link validation (`done --pr`, `add --pr`,
 * backend normalization), and public-followup `pr_url` deliverables.
 *
 * Exactly three byte-for-byte shapes are PR URLs:
 *   - GitHub:  https://github.com/<owner>/<repo>/pull/<n>
 *   - Forgejo: https://<lowercase-dns-host>/<owner>/<repo>/pulls/<n>
 *   - GitLab:  https://<lowercase-dns-host>/<group>[/<subgroup>...]/<project>/-/merge_requests/<n>
 * with <n> a positive number without leading zeros. Anything else - issue URLs,
 * singular/plural route confusion, trailing slash, query/fragment, whitespace,
 * userinfo, ports, encoded separators, MR sub-pages - is not a PR URL.
 */

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SEGMENT = "[A-Za-z0-9._-]+";
const HOST = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`;
const NUMBER = "[1-9][0-9]*";
const PR_URL_RE = new RegExp(
  `^https://(${HOST})/(${SEGMENT})/(${SEGMENT})/(pull|pulls)/${NUMBER}$`,
);
// GitLab groups nest, so the project path is two or more segments.
const GITLAB_MR_URL_RE = new RegExp(
  `^https://${HOST}/(${SEGMENT}(?:/${SEGMENT})+)/-/merge_requests/${NUMBER}$`,
);

export const PR_URL_EXPECTED =
  "a canonical pull request URL: https://github.com/<owner>/<repo>/pull/<n> (GitHub), https://<host>/<owner>/<repo>/pulls/<n> (Forgejo), or https://<host>/<group>/<project>/-/merge_requests/<n> (GitLab)";

/** True when url is byte-for-byte a canonical GitHub, Forgejo, or GitLab PR URL. */
export function isPrUrl(url: string): boolean {
  const mr = GITLAB_MR_URL_RE.exec(url);
  if (mr !== null) {
    return mr[1]
      .split("/")
      .every((seg) => seg !== "." && seg !== ".." && seg !== "-");
  }
  const m = PR_URL_RE.exec(url);
  if (m === null) return false;
  const [, host, owner, repo, route] = m;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return false;
  }
  return route === "pull" ? host === "github.com" : host !== "github.com";
}
