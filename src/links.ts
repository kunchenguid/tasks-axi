import type { TaskLink } from "./model.js";
import { isPrUrl } from "./pr-url.js";

const REPORT_LINK = /\bdata\/\S+?\/report\.md\b/g;
const GENERIC_URL = /https?:\/\/\S+/g;

function trimUrl(url: string): string {
  return url.replace(/[).,;]+$/, "");
}

/** Derive typed links by scanning prose (links live in the prose, not as tags). */
export function deriveLinks(text: string): TaskLink[] {
  const links: TaskLink[] = [];
  const seen = new Set<string>();
  const add = (kind: TaskLink["kind"], raw: string) => {
    const url = trimUrl(raw);
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ kind, url });
  };
  for (const m of text.matchAll(GENERIC_URL)) {
    if (isPrUrl(trimUrl(m[0]))) add("pr", m[0]);
  }
  for (const m of text.matchAll(REPORT_LINK)) add("report", m[0]);
  for (const m of text.matchAll(GENERIC_URL)) {
    if (!isPrUrl(trimUrl(m[0]))) add("doc", m[0]);
  }
  return links;
}
