# Saltline handoff (2026-10-15, end of session)

## How deploys work (no git on the workspace pod, GitHub is the source of truth)
1. Work in a clone/worktree of github.com/Wvdstoep/saltline (main). Test: `node --test test/<file>`; full suite on Windows has 29 known failing tests (Windows-only: sail-server, inland-3d, inland-fixture, route-planner, sail-tactics, wtmesh, wt-wiring, wt-ports, telegraph, quaywire, quays, quaygame, inland-moor).
2. Push to GitHub main (git credential manager is signed in on the laptop).
3. SSH `carla@65.108.13.228` (passwordless). Workspace pod: `kubectl exec` into pod `app-mavicpro-fan-saltline-*` in ns `pod-mavicpro-fan`; `cd /app/workspace/saltline-app && git -c safe.directory=... fetch origin main && git reset --hard origin/main`; back up first: `cp data/state.json data/state.pre-<name>-HHMM.json`. NEVER touch data/state.json or data/secrets.
4. Browser-only files need no restart. Server files need a restart: use the platform restart (my-app deploy_app saltline, workdir saltline-app, command `rm -rf data/tiles && npm start`), not `kubectl rollout restart` (the controller then re-rolls).

## Live now (main)
Water (ocean2.js: variant ladder, phone builds without runtime-indexed uniform arrays/loops/inout/discard because Adreno 660 rejects them; curved wake; breaking crests; diag panel `?diag=1`), sky (physical atmosphere, one Moon, clouds, exposure, Shift+L work lights), ship skins + HD KTX2 texture library (public/assets/lib, texlib.js; ambientCG CC0, see SOURCES.md), casino built in code (no GLTF), city layer (OSM buildings), lock/bridge T-junction fix, cruise ships, pirates/navy, economy.

## In progress (worktrees in the scratchpad, branches on the laptop only unless pushed)
- int-light (wt-light): CSM sun shadows, GTAO, bloom pipeline. NOTES-light.md
- int-people (wt-people): one HD people system (skeleton + clothing atlas), catamaran deck-height bug. NOTES-people.md
- int-ships2 (wt-ships2): cruise balconies/davits/stepped decks, merchant railings, rust as streaks. NOTES-ships2.md
- int-fft (wt-fft): FFT ocean for desktop (Gerstner stays for phones; heightAt unchanged). NOTES-fft.md
Each has uncommitted work on disk; commit it to its branch, merge main, test, deploy as above.

## Open items
- Phone water: confirm via `?diag=1` that rungs now show `full-lean` (user's phone is Adreno 660, Chrome 155).
- Cloud streaks fix is live but unverified on a real GPU; storm/overcast brightness calibrated numerically only.
- HD plan: docs/HD-ASSET-PLAN.md phases 2+ (quays/harbour buildings, tree billboards, city facade atlas, interiors texture array, containers).
- Economy follow-ups: job-board "destination also requests" badge, inland harbour trade UI.
- Decision pending: should casino styling also apply to lounges/bars (one condition in iv2draw.js)?
- Pending user decision: express passage to the 21 war-risk harbours.
- Laptop disk C: nearly full (keep scratchpad small).
