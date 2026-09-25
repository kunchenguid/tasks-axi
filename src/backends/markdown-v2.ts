/**
 * The hierarchical ("roots", v2) backlog layout owned by tracker-axi: request
 * nodes as `## [m] N. <title> <!--#id-->` headings, tasks as nested
 * `- [m] N. <title> <tags> <!--#id-->` checkboxes, state carried by the leaf
 * checkbox, and parent/node markers plus sibling ordinals derived from the tree.
 *
 * tasks-axi keeps its section-based store: a v2 file is read into the same
 * state-section document the flat grammar produces (so every command sees the
 * same tasks), the tree is kept alongside it, and a write folds the mutated
 * tasks back into the tree in place. Nothing is ever dropped silently: any
 * line the layout cannot own is a hard error, as in tracker-axi's parser.
 */
import { AxiError } from "../errors.js";
import {
  parseBacklog,
  renderTaskLines,
  type BacklogDoc,
  type TaskEntry,
} from "./markdown-grammar.js";
import type { State } from "../model.js";

type Marker = " " | "/" | "x";
const MARKER_STATE: Record<Marker, State> = { " ": "queued", "/": "in_flight", x: "done" };
const STATE_MARKER: Record<string, Marker> = { queued: " ", in_flight: "/", done: "x" };

const ID_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]*";
const HEADING = /^(#{2,6})\s+(.*)$/;
const NODE_HEAD = /^\[([ /x])\]\s+(\d+)\.\s+(.*)$/;
const TASK_LINE = /^(\s*)-\s+\[([ /x])\]\s+(\d+)\.\s+(.*)$/;
const ANY_BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const ID_COMMENT = new RegExp(`\\s*<!--#(${ID_SOURCE})-->\\s*$`);
const FLAT_SECTIONS = new Set(["in flight", "queued"]);
const INDENT = 2;
const UNFILED = "unfiled";

interface V2Task {
  id: string;
  /** Record prose between the ordinal and the id comment, verbatim. */
  prose: string;
  /** Leaf state as written; recomputed for parents. */
  state: State;
  body: string[];
  /** Blank lines between this task's body and its first child, preserved verbatim. */
  childSeparator: string[];
  children: V2Task[];
}

interface V2Node {
  id: string;
  prose: string;
  body: string[];
  tasks: V2Task[];
  nodes: V2Node[];
}

export interface V2Tree {
  preamble: string[];
  nodes: V2Node[];
  /** Effective state of every parent task at load, so writes cannot set one. */
  parentState: Map<string, State>;
  /** Newline style observed at load, so a write preserves CRLF files. */
  newline: "\n" | "\r\n";
}

/** Documents parsed from a v2 file carry their tree; the flat grammar never sets it. */
export type MaybeV2Doc = BacklogDoc & { v2?: V2Tree };

function fail(message: string, line: number, help: string[] = []): never {
  throw new AxiError(`backlog v2 line ${line}: ${message}`, "VALIDATION_ERROR", help);
}

function isFlatSection(rest: string): boolean {
  const t = rest.trim().toLowerCase();
  return FLAT_SECTIONS.has(t) || t.startsWith("done");
}

/** Structural detection, mirroring tracker-axi: marked node headings mean v2; a mix is refused. */
export function isV2(src: string): boolean {
  let flat = 0;
  let roots = 0;
  for (const line of src.split("\n")) {
    const m = line.replace(/\r$/, "").match(HEADING);
    if (!m) continue;
    const rest = (m[2] as string).trim();
    if (NODE_HEAD.test(rest)) roots++;
    else if (isFlatSection(rest)) flat++;
  }
  if (roots > 0 && flat > 0) {
    throw new AxiError("backlog mixes the flat state sections and v2 node headings", "VALIDATION_ERROR", [
      "Restore the file and migrate the whole file with `tracker-axi backlog migrate`",
    ]);
  }
  return roots > 0;
}

function splitId(text: string, line: number, what: string): { id: string; prose: string } {
  const m = text.match(ID_COMMENT);
  if (!m || m.index === undefined) fail(`${what} is missing its stable id comment`, line);
  return { id: m[1] as string, prose: text.slice(0, m.index) };
}

function aggregate(states: State[]): State {
  if (states.length === 0) return "queued";
  const done = states.filter((s) => s === "done").length;
  if (done === states.length) return "done";
  if (done === 0 && !states.includes("in_flight")) return "queued";
  return "in_flight";
}

function effective(task: V2Task): State {
  return task.children.length === 0 ? task.state : aggregate(task.children.map(effective));
}

function nodeState(node: V2Node): State {
  return aggregate([...node.tasks.map(effective), ...node.nodes.map(nodeState)]);
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseV2(src: string): V2Tree {
  const lines = src.replace(/\n$/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  let i = 0;
  const preamble: string[] = [];
  while (i < lines.length && !HEADING.test(lines[i] as string)) preamble.push(lines[i++] as string);
  while (preamble.length > 0 && preamble[preamble.length - 1] === "") preamble.pop();
  const seen = new Set<string>();
  const fresh = (id: string, line: number): void => {
    if (seen.has(id)) fail(`duplicate id "${id}"`, line);
    seen.add(id);
  };

  const body = (indent: number): string[] => {
    const out: string[] = [];
    const pad = " ".repeat(indent);
    while (i < lines.length) {
      const raw = lines[i] as string;
      if (raw.trim() === "") {
        const next = lines[i + 1];
        if (next === undefined || !next.startsWith(pad) || next.trim() === "" || TASK_LINE.test(next)) break;
        out.push("");
        i++;
        continue;
      }
      if (!raw.startsWith(pad) || TASK_LINE.test(raw)) break;
      if (ANY_BULLET.test(raw) && raw.length - raw.trimStart().length === indent) {
        fail(`list item is not a task record: ${JSON.stringify(raw.trim().slice(0, 60))}`, i + 1);
      }
      out.push(raw.slice(indent));
      i++;
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  };

  const checks: Array<() => void> = [];

  const childSeparator = (indent: number): string[] => {
    const start = i;
    const out: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() === "") out.push(lines[i++] as string);
    const next = lines[i] as string | undefined;
    const match = next?.match(TASK_LINE);
    if (match && (match[1] as string).length === indent) return out;
    i = start;
    return [];
  };

  const tasks = (indent: number, owner: string): V2Task[] => {
    const out: V2Task[] = [];
    while (i < lines.length) {
      const raw = lines[i] as string;
      if (raw.trim() === "") {
        i++;
        continue;
      }
      if (HEADING.test(raw)) return out;
      const m = raw.match(TASK_LINE);
      if (!m) {
        if (ANY_BULLET.test(raw)) fail(`list item is not a task record: ${JSON.stringify(raw.trim().slice(0, 60))}`, i + 1);
        if (indent === 0) fail(`stray prose at column 0 under node "${owner}"`, i + 1);
        return out;
      }
      const found = (m[1] as string).length;
      if (found < indent) return out;
      if (found > indent) fail(`task is indented ${found} spaces where ${indent} was expected`, i + 1);
      const line = i + 1;
      const marker = m[2] as Marker;
      const ordinal = Number(m[3]);
      const { id, prose } = splitId(m[4] as string, line, "task record");
      fresh(id, line);
      i++;
      const taskBody = body(indent + INDENT);
      const task: V2Task = {
        id,
        prose,
        state: MARKER_STATE[marker],
        body: taskBody,
        childSeparator: childSeparator(indent + INDENT),
        children: [],
      };
      task.children = tasks(indent + INDENT, owner);
      const pos = out.length + 1;
      checks.push(() => {
        if (STATE_MARKER[effective(task)] !== marker) fail(`stale marker on "${id}"`, line, ["Run `tracker-axi backlog lint --fix`"]);
        if (ordinal !== pos) fail(`stale ordinal on "${id}"`, line, ["Run `tracker-axi backlog lint --fix`"]);
      });
      out.push(task);
    }
    return out;
  };

  const nodes = (level: number): V2Node[] => {
    const out: V2Node[] = [];
    while (i < lines.length) {
      const raw = lines[i] as string;
      const head = raw.match(HEADING);
      if (!head) fail(`expected a node heading, found ${JSON.stringify(raw.slice(0, 60))}`, i + 1);
      const depth = (head[1] as string).length;
      if (depth < level) return out;
      if (depth > level) fail(`node heading jumps from level ${level} to ${depth}`, i + 1);
      const line = i + 1;
      const marked = (head[2] as string).trim().match(NODE_HEAD);
      if (!marked) fail("node heading is missing its derived marker and ordinal", line);
      const marker = marked[1] as Marker;
      const ordinal = Number(marked[2]);
      const { id, prose } = splitId(marked[3] as string, line, "node heading");
      fresh(id, line);
      i++;
      const node: V2Node = { id, prose, body: body(INDENT), tasks: [], nodes: [] };
      node.tasks = tasks(0, id);
      node.nodes = nodes(level + 1);
      const pos = out.length + 1;
      checks.push(() => {
        if (STATE_MARKER[nodeState(node)] !== marker) fail(`stale marker on node "${id}"`, line, ["Run `tracker-axi backlog lint --fix`"]);
        if (ordinal !== pos) fail(`stale ordinal on node "${id}"`, line, ["Run `tracker-axi backlog lint --fix`"]);
      });
      out.push(node);
    }
    return out;
  };

  const tree: V2Tree = {
    preamble,
    nodes: nodes(2),
    parentState: new Map(),
    newline: src.includes("\r\n") ? "\r\n" : "\n",
  };
  if (i < lines.length) fail("unreachable content after the last node", i + 1);
  for (const check of checks) check();
  walkTasks(tree, (t) => {
    if (t.children.length > 0) tree.parentState.set(t.id, effective(t));
  });
  return tree;
}

function walkTasks(tree: V2Tree, fn: (t: V2Task, siblings: V2Task[], idx: number) => void): void {
  const visitTasks = (list: V2Task[]): void => {
    list.forEach((t, idx) => {
      fn(t, list, idx);
      visitTasks(t.children);
    });
  };
  const visitNodes = (list: V2Node[]): void => {
    for (const n of list) {
      visitTasks(n.tasks);
      visitNodes(n.nodes);
    }
  };
  visitNodes(tree.nodes);
}

/** The state-section view every tasks-axi command operates on. */
export function v2ToDoc(tree: V2Tree): MaybeV2Doc {
  const by: Record<string, string[]> = { in_flight: [], queued: [], done: [] };
  const done: Array<{ date: string; pos: number; lines: string[] }> = [];
  let pos = 0;
  walkTasks(tree, (t) => {
    const state = effective(t);
    const lines = [`${state === "done" ? "- [x] " : "- [ ] "}${t.id} - ${t.prose.trim()}`];
    for (const b of t.body) lines.push(b === "" ? "" : `  ${b}`);
    if (state !== "done") {
      (by[state] as string[]).push(...lines);
      return;
    }
    const date = t.prose.match(/\((?:merged|reported|done|closed)\s+(\d{4}-\d{2}-\d{2})\)/)?.[1] ?? "";
    done.push({ date, pos: pos++, lines });
  });
  // The flat Done section is newest-first and retention prunes its tail; the
  // map has no recency order of its own, so rank by close date, then treat a
  // later position (new rows append to Unfiled) as more recent.
  done.sort((a, b) => (a.date === b.date ? b.pos - a.pos : a.date < b.date ? 1 : -1));
  by.done = done.flatMap((d) => d.lines);
  const src = [
    "# Backlog",
    "",
    "## In flight",
    ...(by.in_flight as string[]),
    "",
    "## Queued",
    ...(by.queued as string[]),
    "",
    "## Done",
    ...(by.done as string[]),
    "",
  ].join("\n");
  const doc: MaybeV2Doc = parseBacklog(src);
  doc.v2 = tree;
  return doc;
}

/**
 * Done tasks that retention must keep: a task placed under a request root is
 * that root's completion evidence, and archiving it would erase the roll-up
 * (a finished root would read as not started). Only Unfiled work is pruned.
 */
export function v2PinnedDone(doc: MaybeV2Doc): Set<string> {
  const pinned = new Set<string>();
  if (!doc.v2) return pinned;
  const visit = (list: V2Node[]): void => {
    for (const n of list) {
      if (n.id !== UNFILED) {
        const all = (ts: V2Task[]): void => ts.forEach((t) => (pinned.add(t.id), all(t.children)));
        all(n.tasks);
      }
      visit(n.nodes);
    }
  };
  visit(doc.v2.nodes);
  return pinned;
}

// ---------------------------------------------------------------------------
// Write back
// ---------------------------------------------------------------------------

const V1_ROW = new RegExp(`^- (?:\\[[ xX]\\] |\\*\\*)(${ID_SOURCE})(?:\\*\\*)? - (.*)$`);

function fromEntry(entry: TaskEntry): { prose: string; body: string[] } {
  const lines = renderTaskLines(entry.task);
  const m = (lines[0] as string).match(V1_ROW);
  if (!m) throw new AxiError(`cannot render task "${entry.task.id}" as a v2 record`, "UNKNOWN");
  const body = lines.slice(1).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return { prose: m[2] as string, body };
}

/** Fold the mutated state-section document back into its v2 tree and render it. */
export function renderV2(doc: MaybeV2Doc): string {
  const tree = doc.v2 as V2Tree;
  const entries = new Map<string, TaskEntry>();
  const order: string[] = [];
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.kind !== "task") continue;
      entries.set(entry.task.id, entry);
      order.push(entry.task.id);
    }
  }
  const placed = new Set<string>();
  const update = (list: V2Task[]): V2Task[] =>
    list.flatMap((t) => {
      const entry = entries.get(t.id);
      t.children = update(t.children);
      if (!entry) {
        if (t.children.length > 0) {
          throw new AxiError(`Task "${t.id}" still has child tasks in the backlog map`, "VALIDATION_ERROR", [
            "Remove or move its children first",
          ]);
        }
        return [];
      }
      placed.add(t.id);
      if (entry.dirty) {
        const next = fromEntry(entry);
        t.prose = `${next.prose} `;
        t.body = next.body;
      }
      if (t.children.length === 0) {
        t.state = entry.task.state as State;
      } else if (entry.task.state !== tree.parentState.get(t.id)) {
        throw new AxiError(
          `Task "${t.id}" is a parent in the backlog map; its state is derived from its children`,
          "VALIDATION_ERROR",
          ["Change the state of its child tasks instead"],
        );
      }
      return [t];
    });
  const visit = (list: V2Node[]): void => {
    for (const n of list) {
      n.tasks = update(n.tasks);
      visit(n.nodes);
    }
  };
  visit(tree.nodes);

  const added = order.filter((id) => !placed.has(id));
  if (added.length > 0) {
    // Fail closed before writing: the rendered file is re-parsed on the next
    // read and parseV2 rejects duplicate ids, so a collision introduced here
    // would leave an unreadable backlog behind. Throwing here runs before
    // persist's atomic write, so the file stays untouched.
    const treeIds = new Set<string>();
    const collect = (list: V2Node[]): void => {
      for (const n of list) {
        treeIds.add(n.id);
        const tasks = (ts: V2Task[]): void => {
          for (const t of ts) {
            treeIds.add(t.id);
            tasks(t.children);
          }
        };
        tasks(n.tasks);
        collect(n.nodes);
      }
    };
    collect(tree.nodes);
    let unfiled = tree.nodes.find((n) => n.id === UNFILED);
    const creating = !unfiled;
    const after = new Set(treeIds);
    if (creating) {
      if (after.has(UNFILED)) {
        throw new AxiError(`Cannot file new tasks: id "${UNFILED}" is already used in the backlog map`, "VALIDATION_ERROR", [
          "Rename the existing record so the Unfiled request root can be created",
        ]);
      }
      after.add(UNFILED);
    }
    for (const id of added) {
      if (id === UNFILED) {
        throw new AxiError(`Task id "${UNFILED}" is reserved for the Unfiled request root`, "VALIDATION_ERROR", [
          "Pick a different task id",
        ]);
      }
      if (after.has(id)) {
        throw new AxiError(`Cannot file new task "${id}": the id is already used in the backlog map`, "VALIDATION_ERROR", [
          "Pick a different task id",
        ]);
      }
      after.add(id);
    }
    if (!unfiled) {
      unfiled = { id: UNFILED, prose: "Unfiled ", body: [], tasks: [], nodes: [] };
      tree.nodes.push(unfiled);
    }
    for (const id of added) {
      const entry = entries.get(id) as TaskEntry;
      const next = fromEntry(entry);
      unfiled.tasks.push({
        id,
        prose: `${next.prose} `,
        state: entry.task.state as State,
        body: next.body,
        childSeparator: [],
        children: [],
      });
    }
  }

  const out: string[] = [...tree.preamble];
  const renderTask = (t: V2Task, ordinal: number, depth: number): void => {
    const pad = " ".repeat(depth * INDENT);
    out.push(`${pad}- [${STATE_MARKER[effective(t)]}] ${ordinal}. ${t.prose.trimEnd()} <!--#${t.id}-->`);
    const bodyPad = " ".repeat((depth + 1) * INDENT);
    for (const b of t.body) out.push(b === "" ? "" : `${bodyPad}${b}`);
    if (t.children.length > 0) out.push(...t.childSeparator);
    t.children.forEach((c, k) => renderTask(c, k + 1, depth + 1));
  };
  const renderNode = (n: V2Node, ordinal: number, level: number): void => {
    out.push(`${"#".repeat(level)} [${STATE_MARKER[nodeState(n)]}] ${ordinal}. ${n.prose.trimEnd()} <!--#${n.id}-->`);
    for (const b of n.body) out.push(b === "" ? "" : `  ${b}`);
    if (n.body.length > 0 && n.tasks.length > 0) out.push("");
    n.tasks.forEach((t, k) => renderTask(t, k + 1, 0));
    n.nodes.forEach((c, k) => {
      out.push("");
      renderNode(c, k + 1, level + 1);
    });
  };
  tree.nodes.forEach((n, k) => {
    if (out.length > 0) out.push("");
    renderNode(n, k + 1, 2);
  });
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return tree.newline === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
