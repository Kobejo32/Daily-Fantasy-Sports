# Web application source reference

This folder preserves selected TypeScript and React source from the DFS dashboard. It demonstrates how lineup optimization, research views, account permissions, and subscriptions were connected in the original application.

This is **not a deployable website**. The public export omits the original deployment configuration, middleware and deployment-specific JWT key, internal/admin/AI operations, production data, branding assets, styles, and live integration setup. Some retained pages link to omitted routes. The package manifest below supports the isolated tests only; it is not the original application's dependency manifest. No production service is configured by this repository.

## Code tour

| Area | Start here | Engineering question |
| --- | --- | --- |
| Constrained lineup optimization | [optimizer.ts](src/lib/optimizer.ts), [fd-optimizer.ts](src/lib/fd-optimizer.ts) | How do salary, roster, team, and player constraints become a solver problem? |
| Regression from a data mismatch | [optimizer.team-cap.test.ts](src/lib/optimizer.team-cap.test.ts) | Can team abbreviation differences accidentally bypass a roster cap? |
| Account permissions | [auth.ts](src/lib/auth.ts), [auth.test.ts](src/lib/auth.test.ts) | How are authentication, subscription tiers, and sport permissions separated? |
| Subscription lifecycle | [stripe.ts](src/lib/stripe.ts), [webhook route](src/app/api/stripe/webhook/route.ts) | How do server-verified events update subscription state? |
| User-scoped records | [saved lineup route](src/app/api/lineups/saved/route.ts), [balance route](src/app/api/bankroll/balances/route.ts) | How are reads and writes tied to the signed-in user? |
| Research UI | [projections page](src/app/projections-v2/page.tsx), [signal breakdown](src/components/SignalBreakdown.tsx) | How can users inspect projections and their underlying inputs? |

## Run the isolated tests

Use Node.js 22 and npm:

```bash
cd web
npm ci --ignore-scripts
npm test
```

The tests use synthetic player pools and mocked account/database responses. They do not need credentials or make production API requests. These checks cover the published optimizer and permission examples, not the complete original website.

## Publication changes

- Original customer/account identities were replaced with explicitly synthetic examples.
- Real service domains and mailboxes were replaced with `example.com` placeholders.
- Internal operational routes, account administration, live upload dispatch, deployment middleware, embedded verification keys, private prose, and integration tests were omitted.
- Public sports API URLs remain in source to explain integrations; the unit test command does not invoke them.
- One correction was made during publication: the DraftKings optimizer now canonicalizes team labels before constructing hitter-cap constraints. The existing regression test caught mixed-case and whitespace variants bypassing the shared cap.
- Historical code comments and default model parameters describe the archived implementation. They are not claims of current performance or recommendations to enter contests.

The source retains legacy paths and migration shims where they help explain the actual project. It has not been refactored into a new application or certified for production use.
