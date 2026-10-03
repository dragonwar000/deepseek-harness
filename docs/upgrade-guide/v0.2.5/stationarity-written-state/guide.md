---
kind: upgrade-guide
description: "stationarity-guard also stops a turn whose written files return to an earlier content state, and it reads those files through the filesystem service."
---

# stationarity-guard stops repeated file states

## Change

`@deepseek-ai/dsh-experimental-stationarity-guard` used to compare only each step's tool calls and their results. It now also hashes the content of every file a `writeTools` call named since the last human message, after each write step. When one state recurs `stateRepeatStopAt` times (default `2`), the guard records a `stop` with reason `repeat`.

A file the agent writes twice with identical content, or an edit that is reverted and re-applied, now counts as a repeat. In `shadow` mode, which the bundle ships with, the decision is only recorded as `loop/stationarity`. In `enforce` mode, the next step is rejected, the turn ends `blocked`, and an active goal is blocked with code `stationary`. Deployments that enforce this guard may see new stops on turns that previously completed.

The guard now also injects the `fs` service, so a deployment must provide one. The bundle already does.

## Migration

1. If you run this guard in `enforce` and a turn now stops, read its `loop/stationarity` event. Its `signature` is the state hash, and `repeats` is how many times that state occurred.
2. To keep the earlier behaviour, set the threshold above any repeat you accept. For example:

   ```yaml
   - id: stationarity-guard
     config:
       mode: enforce          # restate every other field you keep
       assumption: "..."      # restate it: a patch replaces the whole row config
       stateRepeatStopAt: 1000
   ```

   The minimum accepted value is `2`, so `1000` effectively disables the check.
3. Large files are compared by version token and not read. Tune `maxHashBytes` if a file you rewrite identically is larger than the default `262144` bytes and must be recognized as a repeat.
4. Confirm: in `shadow` mode, run one turn that rewrites a file to the same content, and check the session log for a `loop/stationarity` event with `reason: repeat`.
