import { describe, expect, it } from "vitest";

import { isPrUrl } from "../src/pr-url.js";

describe("isPrUrl", () => {
  it.each([
    "https://github.com/o/r/pull/42",
    "https://github.com/some-owner/some.repo/pull/1",
    "https://forgejo.samesies.gay/eve/orchalycious/pulls/39",
    "https://codeberg.org/forgejo/forgejo/pulls/1234",
    "https://gitlab.com/o/r/-/merge_requests/42",
    "https://gitlab.com/arizona-crossmedia/visto-tecnologia/visto/go-ng/-/merge_requests/215",
    "https://gitlab.example.com/group/subgroup/project/-/merge_requests/7",
  ])("accepts canonical PR URL %s", (url) => {
    expect(isPrUrl(url)).toBe(true);
  });

  it.each([
    // singular/plural route confusion
    "https://github.com/o/r/pulls/42",
    "https://forgejo.samesies.gay/eve/orchalycious/pull/39",
    // merge request route shape
    "https://gitlab.com/o/r/merge_requests/42",
    "https://gitlab.com/o/r/-/merge_requests/0",
    "https://gitlab.com/o/r/-/merge_requests/042",
    "https://gitlab.com/o/r/-/merge_requests/42abc",
    "https://gitlab.com/o/-/merge_requests/42",
    "https://gitlab.com/o/r/-/merge_requests/42/",
    "https://gitlab.com/o/r/-/merge_requests/42?w=1",
    "https://gitlab.com/o/r/-/merge_requests/42#note_1",
    "https://gitlab.com//o/r/-/merge_requests/42",
    "https://gitlab.com/o/../r/-/merge_requests/42",
    "https://github.com/o/r/-/merge_requests/42",
    "https://GitLab.com/o/r/-/merge_requests/42",
    // issue URLs
    "https://github.com/o/r/issues/42",
    "https://forgejo.samesies.gay/o/r/issues/42",
    "https://gitlab.com/o/r/-/issues/42",
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
    "https://token:secret@gitlab.com/o/r/-/merge_requests/39",
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
  ])("rejects non-canonical URL %j", (url) => {
    expect(isPrUrl(url)).toBe(false);
  });
});
