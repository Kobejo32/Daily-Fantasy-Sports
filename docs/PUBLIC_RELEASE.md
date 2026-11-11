# Public release scope

This is a curated source snapshot of a historical DFS project archived on September 5, 2026. The public repository starts with new Git history and contains selected computational modules, configuration constants, synthetic unit tests, a new offline demonstration, and a source reference for the original web application.

## Included and excluded

The release preserves core research and optimization implementations across baseball, golf, basketball, and football. The runnable entry point is `examples/synthetic_research.py`; `scripts/verify.py` runs the selected Python tests in separate processes with sockets disabled. The web folder has its own isolated unit-test environment.

Excluded material includes original Git history, account/session cookies, credentials and deployment keys, private user records, internal correspondence and research journals, runtime state, live orchestration scripts, authenticated browser acquisition, raw vendor projections, contest exports, databases, model artifacts, and private historical evaluation datasets. No third-party datasets are redistributed.

The complete application and its production data pipeline are not reproduced. Retained reference modules can refer to omitted artifacts or optional integrations. Some archived adapters were intentionally excluded; this release does not promise that every original operational entry point runs.

## Changes made for this edition

- Credential defaults and production identifiers were removed from retained configuration and source.
- Personal paths were replaced with repository-relative paths or generic local placeholders; historical integration modules may still need explicit configuration.
- Private evaluation metadata was removed from the engine registry. Historical comments elsewhere describe archived assumptions, not a verified public performance claim.
- One archived Python signal module stored as escaped text was decoded to valid Python source.
- The web optimizer's existing team-cap regression test exposed inconsistent team-label normalization. Team labels are now canonicalized before constraints are built; see `web/README.md`.
- Existing Python team-cap tests required a stricter optional cap that the archived optimizer signatures did not accept. The cash optimizers now accept and validate that parameter, retaining their platform defaults and applying stricter limits through solver and fallback paths.
- The optional MLB database client now checks configuration and imports its SDK only when invoked, so numerical modules can be imported without installing a live-service SDK. Legacy NFL tests were adapted to pytest's return convention without changing their assertions.
- The README, synthetic research demo, test runner, dependency manifests, and release documentation were prepared for this public edition.

## Verification boundaries

Verified on November 10, 2026:

| Check | Result |
| --- | --- |
| Python 3.12, fresh virtual environment using `requirements.txt` | 184 tests passed: MLB 103, PGA 18, NBA 47, NFL 16; sockets disabled. |
| Node.js 22, isolated web unit suite | 28 tests passed: permissions 21, optimizer 7. |
| Fixed-seed synthetic demo | Completed; roster and portfolio checks passed. Captured output is in `demo-output.txt`. |
| Python syntax and documentation links | All retained Python files parse; relative README links resolve. |
| Public source and new commit secret scans | Gitleaks 8.30.1, zero findings; separate identifier/data review completed. |

The synthetic demonstration checks candidate roster feasibility and portfolio constraints, with separate simulation draws for selection and evaluation. It demonstrates the implemented procedure conditional on synthetic assumptions, not forecast accuracy, profitability, or real-contest returns.

The selected Python unit tests cover numerical evaluation, constraint enforcement, forecast blending, and additional sport-specific lineup behavior. The web unit tests cover mocked account permissions and synthetic optimizer cases. These checks do not exercise live accounts, vendor APIs, historical data pipelines, payments, or website deployment.

Before publication, the staged files and fresh commit are checked with Gitleaks and a separate review for embedded identifiers, private data, and unexpected file types. These checks support the publication review; they are not a guarantee that historical application code is production-ready.
