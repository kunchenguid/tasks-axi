/**
 * Canonical pull/merge request URL classification - the single seam shared by
 * prose link derivation (deriveLinks), typed-link validation (`done --pr`,
 * `add --pr`, backend normalization), and public-followup `pr_url` deliverables.
 *
 * Exactly three byte-for-byte shapes are PR URLs:
 *   - GitHub:  https://github.com/<owner>/<repo>/pull/<n>
 *   - Forgejo: https://<lowercase-dns-host>/<owner>/<repo>/pulls/<n>
 *   - GitLab:  https://<lowercase-dns-host>/<namespace...>/<project>/-/merge_requests/<n>
 * with <n> a positive number without leading zeros. A GitLab project can sit
 * under nested groups, so its path holds one or more namespace segments before
 * the project segment. Anything else - issue URLs, singular/plural route
 * confusion, a merge_requests route without the `/-/` separator, a GitLab path
 * of fewer than two segments (GitLab always serves a namespace + project),
 * trailing slash, query/fragment, whitespace, userinfo, ports, encoded
 * separators - is not a PR URL.
 */

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`;
const SEGMENT = "[A-Za-z0-9._-]+";
const GITHUB_PR_RE = new RegExp(
  `^https://github\\.com/(${SEGMENT})/(${SEGMENT})/pull/([1-9][0-9]*)$`,
);
const FORGEJO_PR_RE = new RegExp(
  `^https://(${HOST})/(${SEGMENT})/(${SEGMENT})/pulls/([1-9][0-9]*)$`,
);
const GITLAB_MR_RE = new RegExp(
  `^https://(${HOST})/((?:${SEGMENT}/)+${SEGMENT})/-/merge_requests/([1-9][0-9]*)$`,
);

export const PR_URL_EXPECTED =
  "a canonical pull request URL: https://github.com/<owner>/<repo>/pull/<n> (GitHub), https://<host>/<owner>/<repo>/pulls/<n> (Forgejo), or https://<host>/<namespace>/<project>/-/merge_requests/<n> (GitLab)";

function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/** True when url is byte-for-byte a canonical GitHub, Forgejo, or GitLab PR URL. */
export function isPrUrl(url: string): boolean {
  const github = GITHUB_PR_RE.exec(url);
  if (github !== null) return !hasDotSegment(`${github[1]}/${github[2]}`);

  const forgejo = FORGEJO_PR_RE.exec(url);
  if (forgejo !== null) {
    return (
      forgejo[1] !== "github.com" && !hasDotSegment(`${forgejo[2]}/${forgejo[3]}`)
    );
  }

  const gitlab = GITLAB_MR_RE.exec(url);
  if (gitlab !== null) {
    return gitlab[1] !== "github.com" && !hasDotSegment(gitlab[2]);
  }

  return false;
}
