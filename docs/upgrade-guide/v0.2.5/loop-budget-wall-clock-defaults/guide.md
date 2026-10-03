---
kind: upgrade-guide
description: "loop-budget now bounds wall-clock time by default: 15 minutes per turn and 1 hour per active goal, where it was unbounded."
---

# loop-budget bounds wall-clock time by default

## Change

`@deepseek-ai/dsh-experimental-loop-budget` used to default every wall-clock limit to `0` (off). It now defaults `turn.maxWallMs` to `900000` (15 minutes) and `goal.maxWallMs` to `3600000` (1 hour). Steps, tokens, and USD limits keep their `0` defaults, because they depend on a deployment's model and prices.

A deployment that enables the bundle without setting these fields now gets a wall-clock trip after the new limits. In `shadow` mode, which the bundle ships with, a trip is only recorded as `loop/budget`. In `enforce` mode, the turn's next step is rejected, the turn ends `blocked`, and an active goal is paused.

## Migration

1. Find the `loop-budget` row in your `cordis.yml` or profile patch. It is unchanged if you set `turn.maxWallMs` or `goal.maxWallMs` yourself.
2. To keep the previous unbounded behaviour, set the field to `0`:

   ```yaml
   - id: loop-budget
     config:
       mode: shadow          # restate every other field you keep
       assumption: "..."     # restate it: a patch replaces the whole row config
       turn:
         maxWallMs: 0
       goal:
         maxWallMs: 0
   ```

3. To keep the new bounds, do nothing. If a long but healthy task now trips in `enforce`, raise the matching field rather than setting it to `0`.
4. Confirm: run one long turn in `shadow` mode and check the session log for `loop/budget` events. A trip at the new limit is the expected new record.

Patches replace the whole row config, so restate every other field you keep.
