# DIRECT -> PLAN_SINGLE fallback trigger analysis

The observed value is 2/9 recovered, so the fallback is useful but currently limited. A conservative trigger should remain terminal-failure based, with optional advisory signals only:

- repeated identical tool/error pattern with no new evidence;
- repeated verifier rejection/limit responses;
- a bounded no-new-evidence window;
- explicit infrastructure-clean terminal failure.

Do not silently start Planning while DIRECT is still making new evidence, and do not add hidden retry budgets. Any early trigger must be logged with the reason and retain the original DIRECT artifact.
