# Linked-set `mv` CLI evidence

The successful command moved a blocker and its dependent in one call.

```console
$ pnpm exec tsx bin/tasks-axi.ts mv blocker-b1 dependent-d2 --to .no-mistakes/evidence/fm/taxi-mv-linked-sets-m3/success-destination-after.md --file .no-mistakes/evidence/fm/taxi-mv-linked-sets-m3/success-source-after.md --json
{
  "ok": true,
  "action": "mv",
  "ids": [
    "blocker-b1",
    "dependent-d2"
  ],
  "from": "/Users/kunchen/.no-mistakes/worktrees/6a0c69bae187/01KX58SG95JCMJPFPXFXVY317M/.no-mistakes/evidence/fm/taxi-mv-linked-sets-m3/success-source-after.md",
  "to": "/Users/kunchen/.no-mistakes/worktrees/6a0c69bae187/01KX58SG95JCMJPFPXFXVY317M/.no-mistakes/evidence/fm/taxi-mv-linked-sets-m3/success-destination-after.md"
}
```

The resulting [destination backlog](success-destination-after.md) contains both tasks, the blocker body, and the exact `blocked-by` reason.

The resulting [source backlog](success-source-after.md) contains neither moved task.

Moving only the dependent is rejected before either backlog is changed.

```console
$ pnpm exec tsx bin/tasks-axi.ts mv dependent-d2 --to .no-mistakes/evidence/fm/taxi-mv-linked-sets-m3/refusal-destination-after.md --file .no-mistakes/evidence/fm/taxi-mv-linked-sets-m3/refusal-source-after.md
error: "Cannot move \"dependent-d2\": its blocker \"blocker-b1\" would be stranded (not in the moved set and absent from the destination)"
code: VALIDATION_ERROR
help[1]: "Add \"blocker-b1\" to the same `mv`, or move it to the destination first"
```

The command exited with code 2.

The unchanged [refusal source](refusal-source-after.md) still has the linked pair and the [refusal destination](refusal-destination-after.md) is still empty.
