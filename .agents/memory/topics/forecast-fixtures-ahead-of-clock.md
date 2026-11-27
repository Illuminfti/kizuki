# Forecast fixtures stay ahead of the real clock

Recorded 2026-11-16.

A date the forecast job must observe has to be in the future when the
fixture is imported. The job skips a commitment whose due instant is already
past `ctx.now()`. Derive the review due from import time (30 days ahead) and
derive the day before, the day after, and the conflict date from that
export. Do not leave a literal calendar day in a case the job is supposed to
freeze, and do not pin the test clock to a fixed year that will fall before
a moving due date.

Why: a literal 2026-10-24 went past, 22 forecast tests froze nothing, and
two leftovers still passed a broken check: a conflict date of 2026-10-26,
and a clock pinned at 2030-01-01 that stopped being after the due date. The
same date-rot is what open #1143 was opened for; this commit closed the two
gaps that attempt still had.

Commits: `eb996eb3` (2026-11-12), merged as #1147.
