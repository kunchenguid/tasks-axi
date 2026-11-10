# Beads backend: before -> after

```mermaid
flowchart LR
  subgraph before["PR 52 as submitted"]
    A1[tasks-axi] -->|"cwd = dir of mirror<br/>--force on every create<br/>2.5 s lock wait"| B1[bd]
    A1 -->|"always rewrites"| M1[(backlog.md mirror)]
    B1 --> D1[(.beads db)]
  end
  subgraph after["this branch"]
    A2[tasks-axi] -->|"[beads] bin / dir / prefix<br/>no --force when prefix set<br/>30 s lock wait (lock_timeout_ms)<br/>close reason on done"| B2["bd or any wrapper command"]
    A2 -.->|"only if [markdown] path is set"| M2[(backlog.md mirror)]
    B2 --> D2[(.beads db)]
  end
  before --> after
```

| Concern | Before | After |
| --- | --- | --- |
| Mirror | always written, path doubles as workspace | optional; none unless `[markdown] path` / `--file` |
| Binary / dir / prefix | `bin`, `dir` only | `bin`/`binary`, `dir`/`path`, `prefix`; wrapper works with `dir` unset |
| Id handling | `--force` always | prefix checked up front, `--force` only without a prefix |
| Native bd data | ignored | priority, issue type, dates read for issues without `tasks_axi` metadata |
| Done | no close reason | PR link (or `Closed`) recorded as bd close reason |
| Lock wait | 2.5 s then `LOCKED` | 30 s default, `lock_timeout_ms` configurable |
