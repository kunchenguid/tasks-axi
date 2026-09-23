import { describe, expect, it } from "vitest";

import { isPrUrl } from "../src/pr-url.js";

describe("isPrUrl", () => {
  it.each([
    "https://github.com/o/r/pull/42",
    "https://github.com/some-owner/some.repo/pull/1",
    "https://forgejo.samesies.gay/eve/orchalycious/pulls/39",
    "https://codeberg.org/forgejo/forgejo/pulls/1234",
    // GitHub Enterprise Server uses the GitHub route on its own host
    "https://github.example.com/o/r/pull/42",
    "https://git.corp.example/some-owner/some.repo/pull/7",
    // Bitbucket Cloud and Data Center
    "https://bitbucket.org/workspace/repo/pull-requests/12",
    "https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/3",
    "https://bitbucket.example.com/users/jdoe/repos/repo/pull-requests/3",
  ])("accepts canonical PR URL %s", (url) => {
    expect(isPrUrl(url)).toBe(true);
  });

  it.each([
    // only the GitHub route is a PR route on github.com
    "https://github.com/o/r/pulls/42",
    "https://github.com/o/r/pull-requests/42",
    "https://github.com/projects/P/repos/r/pull-requests/42",
    // unknown or misspelled routes
    "https://forgejo.samesies.gay/o/r/pr/39",
    "https://bitbucket.org/o/r/pull-request/12",
    "https://bitbucket.org/o/r/pullrequests/12",
    // issue URLs
    "https://github.com/o/r/issues/42",
    "https://forgejo.samesies.gay/o/r/issues/42",
    // number shape
    "https://github.com/o/r/pull/0",
    "https://github.com/o/r/pull/042",
    "https://github.com/o/r/pull/42abc",
    "https://forgejo.samesies.gay/o/r/pulls/0",
    // scheme / decoration
    "http://github.com/o/r/pull/42",
    "https://github.com/o/r/pull/42/",
    "https://github.com/o/r/pull/42?w=1",
    "https://github.com/o/r/pull/42#top",
    " https://github.com/o/r/pull/42",
    "https://github.com/o/r/pull/42\n",
    "https://github.com/o/r/pull/4\u00002",
    "https://github.com/o/r/pull/4 2",
    // authority shape
    "https://user@forgejo.samesies.gay/o/r/pulls/39",
    "https://token:secret@github.com/o/r/pull/519",
    "https://forgejo.samesies.gay:8443/o/r/pulls/39",
    "https://Forgejo.Samesies.Gay/o/r/pulls/39",
    "https://-bad-.example.com/o/r/pulls/39",
    // path shape
    "https://forgejo.samesies.gay/o/r/extra/pulls/39",
    "https://forgejo.samesies.gay/r/pulls/39",
    "https://forgejo.samesies.gay//r/pulls/39",
    "https://forgejo.samesies.gay/o%2Fx/r/pulls/39",
    "https://forgejo.samesies.gay/../r/pulls/39",
    "https://forgejo.samesies.gay/o/../pulls/39",
    "https://bitbucket.org/o/r/pull-requests/12/overview",
    "https://bitbucket.org/o/r/pull-requests/012",
    "https://bitbucket.example.com/projects/PROJ/repo/pull-requests/3",
    "https://bitbucket.example.com/groups/PROJ/repos/repo/pull-requests/3",
    "https://bitbucket.example.com/projects/../repos/repo/pull-requests/3",
    "https://bitbucket.example.com/projects/PROJ/repos/./pull-requests/3",
    "https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/0",
    "https://bitbucket.example.com:7990/projects/PROJ/repos/repo/pull-requests/3",
  ])("rejects non-canonical URL %j", (url) => {
    expect(isPrUrl(url)).toBe(false);
  });
});
