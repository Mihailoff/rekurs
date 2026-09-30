# rekurs — operating guide

> Generated from the board manifest — do not edit by hand.

## What to read

- **State** → `.kanbento/views/BOARD.md`: a read-only map of every card and where it sits. Orient from it; re-read after you act (a copy from session start goes stale).
- **How to operate** → this file.

State is read from files; changes go through the CLI — each verb appends to an immutable log and `BOARD.md` re-renders.

## Legend

- `○ options` — uncommitted, discardable — the inbox / pool, left of the commitment point
- `▶ active` — committed work in progress
- `✓ done` — the delivery point (terminal); its entry gate is the Definition of Done
- `[3]` count · `[1/2]` count / WIP · `↳abc12345` parent (lineage) · `↺2` loop-edge rounds (boards that declare a loop flow) · `⟳N` open Rework · `🔗` bound doc · `⛔` blocked · `@scope` product scope (no chip = unscoped) · `→rel=target` ref · bare = about

## This board

A bare pool — no commitment point yet; captured work waits as Options.

Types — record (knowledge layer, flow:false, via `note --type`): `procedure` (file). An embodied type (file/folder) materializes its artifact.

- `○ pool` · options
- `▶ in_progress` · active
- `✓ done` · done

## Verbs

Run inside the repo (the board is found by walking up):

    kanbento init [target] [--from <manifest>] [--template <n>] [--id <id>] [--name <name>]
        create a board (manifest + guide + root anchors)
    kanbento install <workflow>
        vendor a workflow into this board (one-time copy, locked)
    kanbento vendor <url>
        map a public docs site into searchable stubs (sitemap; titles + heading outline; no prose)
    kanbento schema
        print the manifest grammar (closed core + skeleton)
    kanbento capture [text...] [--type <type>] [--slug <slug>] [--from <ref>] [--source <src>] [--key <idem>] [--lane <pair...>] [--scope <s>] [--rel <pair...>] [-F, --body-file <path>] [--title <text>]
        add work to the inbox; a typed capture materializes its file/folder
    kanbento note [text...] [--type <type>] [--slug <slug>] [--scope <ids>] [--title <text>] [--rel <pair...>] [-F, --body-file <path>]
        capture a unit of knowledge — a file in the knowledge layer, not a card (no status, never on the board)
    kanbento transition <ref> <toStage>
        move a card to another stage
    kanbento archive <ref> <stage>
        freeze a card read-only at a stage, off the active board (disposition derived + frozen)
    kanbento run <ref> <exit...> [--max-steps <n>] [--max-stuck <n>]
        autonomously drive a card through the flow until an exit criterion holds
    kanbento worktree
        the card's persistent worktree — a card-scoped branch the coordinator opens before dev and reuses across the stage loop
    kanbento worktree open <ref> [--base <ref>]
        materialize (or reuse) the card worktree and print its path
    kanbento worktree path <ref>
        print the card worktree path if it exists
    kanbento worktree diff <ref>
        compute the card branch diff (base..branch) — a reviewer subject
    kanbento worktree remove <ref>
        remove the card worktree + branch (the explicit teardown at done/abandon)
    kanbento act <ref> [move] [pairs...] [-F, --body-file <path>] [--remark <text>] [--as <role>] [--protocol <name>]
        play a move in the Collaborate protocol — append a binding event to the card enactment (--remark for an untyped note)
    kanbento workspace <ref> [--role <role>]
        the enactment read-model — moves played, bindings, enabled moves + the worktree (a projection over the log)
    kanbento request <dest> [text...] [-F, --body-file <path>] [--title <text>] [--as <handle>]
        request a card on another board — a remote card-creation request
    kanbento feedback [text...] [-F, --body-file <path>] [--title <text>] [--as <handle>]
        send feedback to kanbento (sugar for: request @kanbento)
    kanbento merge <from> <into> [--title <text>] [--discard-doc]
        fold a duplicate card into another (into survives)
    kanbento pool [--ref <curie>] [--sort <axis>] [--type <type>] [--stage <id>] [--scope <id>]
        query the Options pool — filter/sort the pre-commitment set (POOL.md is the canonical overview)
    kanbento search <query...> [--type <type>] [--scope <id>] [--limit <n>]
        ranked whole-store recall — one query over every record, card (archived included), and vendor stub, per-invocation index
    kanbento card <ref> [--path <path>] [--stats]
        print one card as JSON, project a field via --path, or render computed --stats (display-only signals)
    kanbento elaborate <ref> [text...] [-F, --body-file <path>] [--replace] [--title <text>] [--slug <slug>]
        append a body onto a card (a bound doc) or record — materialized on demand; --replace rewrites instead (deliberate consolidation); --slug re-pins the handle
    kanbento reaffirm <ref>
        record a verification: the record was checked against the scope and still holds — stamps verified: git:<sha> (or date: fallback)
    kanbento graduate <ref> <status>
        graduate a record's status through the CLI, appending an identity-stamped RecordGraduated event — the audit trail a bare frontmatter edit lacks (who armed it, when)
    kanbento scope <ref> [s]
        assign or reassign a card's product scope and move the bound doc; omit the value to heal placement for the current scope
    kanbento link <from> <rel> <to>
        connect two knowledge pieces with a typed relation — cards and records alike (no body needed)
    kanbento unlink <from> <rel> <to>
        disconnect two knowledge pieces — retract a typed relation (idempotent; a no-op if absent)
    kanbento checklist <ref> [list] [items...] [-F, --body-file <path>] [--check <n>] [--uncheck <n>] [--check-all] [--uncheck-all] [--retract <n>] [--incomplete]
        a card's named checklists — append-only registers of boolean status items (open↔done) with optional discard (--retract); whole-text restates active items + newcomers (preserves ticks; no hard-delete), --check/--uncheck by stable index, --check-all/--uncheck-all, --retract discards a criterion from the contract, read, and --incomplete gate
    kanbento cases
        case-based decisioning — retain precedents, read the taxonomy to reason from
    kanbento cases taxonomy
        the taxonomy: decision categories + when each applies (the map to classify against)
    kanbento cases retain <category> [--why <text>] [--situation <text>] [--rel <pair...>] [--when <text>]
        record a decision as a precedent under a case category
    kanbento procedures
        list the board's procedures — executable knowing-how, discoverable by any agent
    kanbento do <name> [pairs...] [--finalize [runRef]] [--exec [cmd]] [--dry-run] [--safe] [--no-sandbox]
        print a procedure — params interpolate (key=value), an init hook runs first, declared artifacts state the contract; --exec runs the harness sandboxed end-to-end (one validation retry), --finalize validates + disposes a run (observe/dry/effect by status + flags)
    kanbento schedule [procedure] [--at <HH:MM>] [--remove] [--fire]
        project a procedure's cadence into the OS scheduler (launchd); --fire is the scheduled entry point (guard + headless agent run, halts at the consent gate)
    kanbento watch [ref] [question...] [--on <namespace:id>] [--clear] [--check]
        stand an observation on external state; a check fetches → diffs → matches, emitting only silence or an inbox capture
    kanbento refs [curie] [--from <ref>] [--around <curie>] [--depth <n>] [--rel <key>] [--type <type>] [--frontier]
        references: backlinks to a CURIE, a card's forward edges (--from), or a neighborhood (--around)
    kanbento events
        print the raw event log
    kanbento board [--lane <pair...>]
        render + print the BOARD.md read-model projection
    kanbento compile
        write the drift baseline (compiled.json) + the operating guide
    kanbento lint [--format <fmt>]
        advisory: check records conform to the schema + conventions (read-only)
    kanbento map
        render each record's resolved graph view (views/maps/) + the footprint read-model (views/FOOTPRINTS.md) + the curation read-model (views/CURATION.md) — materialized views (refresh on demand)
    kanbento metrics [--window <7d|all|N>] [--format <text|md>]
        flow metrics — fold the event log into three regions (upstream funnel · delivery pipeline · system balance) + knowledge accrual; prints the summary and writes views/METRICS.md (read-only)
    kanbento diff
        show structural changes since the compiled baseline
    kanbento reconcile
        apply structural changes: re-place orphaned cards, re-baseline
    kanbento upgrade [--dry-run]
        bring an existing board current with the installed kanbento — regenerate generated artifacts, reconcile structural drift
    kanbento sync [--root <dir>] [--write]
        catch-up: reconcile externally created/edited artifacts into the store
    kanbento sweep [--extract <cmd>] [--all] [--cap <n>]
        catch up on changed record files: extract relations into their frontmatter (mtime-driven, idempotent)
    kanbento network
        cross-board networks — declared in manifests, discovered in the tree
    kanbento network list
        list the networks declared across this repo
    kanbento network view <name>
        render the cross-board view of a network

`<ref>` is a card handle `slug@id` (as the board prints it), or any unambiguous part — a bare id, a slug, a CURIE (`type:slug`), or a prefix. In a `slug@id` handle the part after `@` is the key; the slug is advisory.

## How to operate

1. **Orient** — read `BOARD.md` for live state, then decide what to act on yourself: weigh the goal, dependencies, and WIP. The board shows state; the call is yours.
2. **Finish first** — generally clear, unblock, or review work already in flight before pulling new from the pool (a Kanban default — apply it with judgment).
3. **Respect the gates** — pull only into free WIP; a stage's Ready (DoR) and Done (DoD) criteria are judged independently on entry/exit.
4. **Re-read after acting** — a verb changes `BOARD.md`; refresh before the next move.

## Changing the board

Changing the structure (stages, WIP, gates) is a *meta* action, not a plain file edit — in-flight cards must be reconciled. Add structure when the flow earns it. See `.kanbento/EVOLVING.md`.