# Engineering standards — Claude Planet

The canonical workflow doc. The program plan (docs/superpowers/plans/) owns
*what* gets built and *when*; this file owns *how*. If they disagree, this
file wins for process, the plan wins for scope.

## Branching & worktrees

- `~/claude-planet` (the main checkout) stays parked on `main`, always — it
  serves the stable app (`:5173`, the Dock app). Never switch its branch.
- Every wave of work happens in a dedicated worktree:
  `git worktree add ~/.config/superpowers/worktrees/claude-planet/<branch>`
  → own `npm install` → own dev-server port for verification → green
  baseline `npm test` before any builder starts.
- Branch naming: `wave/<milestone-id>` (e.g. `wave/m-wx`). Historical
  branches predate this convention.
- After merge: main checkout `git pull`, worktree removed, branch kept.

## Commits

- Conventional Commits: `type(scope): subject` — types `feat|fix|refactor|
  perf|docs|test|chore|art` (`art` = visual tuning with no logic change).
  Scope = module (`sky`, `world`, `assets`, `plan`, …). Imperative subject.
- No AI attribution of any kind — no co-author trailers, no session links,
  no generated-with footers (standing owner rule).
- Fine-grained commits; revert protocol is `git revert <sha>` + re-run the
  milestone's JIT plan.

## Pull requests

- One PR per wave/milestone. Opens as **draft** when the wave starts,
  collects all wave commits, flips to ready and **self-merges** only after
  the verification gate passes. No review step (solo project, by decision).
- The PR description lists what shipped; the PR template checklist must be
  satisfied truthfully — it is the merge gate's human-readable mirror.

## Verification gate (before any merge)

1. `npm test` green (scanner + resume + geometry suites) and `npm run build`
   clean; CI (`verify` job) green on the PR.
2. Live drive of the real app: console clean except known-benign warns;
   feature-specific checks from the wave's JIT plan.
3. Milestone exits additionally run the verify-kit sweep (5 viewpoints,
   determinism hash, fps ≥55 / ≤18ms frame budget).
4. Tone/lighting changes ship with same-viewpoint before/after screenshot
   pairs, one variable at a time (ART.md discipline).
5. Gallery rule: every verdict packet, milestone shot, and GIF is copied to
   `gallery/YYYY-MM-DD/` with a GALLERY.md line before merge.

## Code standards

- ES modules, vanilla JS, three.js pinned exact — version bumps are
  deliberate, at most one per milestone gate.
- ART.md is binding for anything visible. docs/ART.md §8 anti-rules are
  hard failures in review.
- Silent-fallback rule: every graceful degradation `console.warn`s exactly
  once. `catch {}` without a warn fails review.
- No per-frame allocations in update loops; shared pools for particles;
  deterministic seeding everywhere (`Math.random`/`Date.now` banned in
  world-state code).
- Architect-only files (never assigned to builders): `package.json`,
  `vite.config.js`, `electron/main.cjs`, `src/main.js`, `src/ui.css`.
- One builder per file per wave — file ownership is declared in the wave's
  JIT plan and never overlaps.
- **Formatting/linting: Prettier + ESLint adoption is queued as the first
  commit of the next wave** (a lone `chore: format` on a fresh worktree —
  deliberately not introduced mid-wave to avoid colliding with in-flight
  builder diffs). After that lands, CI enforces both.

## Known constraint

- GitHub branch protection (required status checks) is unavailable on this
  free-tier private repo — CI is therefore mandatory **by convention**: the
  verification gate above is the enforced process, and a red CI on a PR
  blocks the ready/merge step by rule even though GitHub won't physically
  prevent it.

## Deliberately not adopted (decisions, not omissions)

- No review requirement, no CODEOWNERS (solo repo, owner's call).
- No CHANGELOG file — merged PR titles are the changelog.
- No semver churn — tag at program-complete, not per wave.
- No GitHub issue tracker — the program plan is the backlog.
