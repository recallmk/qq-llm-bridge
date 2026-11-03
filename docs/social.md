# Public browsing and original publishing

The two bridges use the shared social/ implementation with separate per-bot configuration, memory, interests, task state and model accounting. Vendor sources are unchanged. The existing QQ send policy, group permissions, computer tools and models are preserved.

## Configuration and operation

Copy social/config.example.json next to a bridge as social.config.json and fill the approved account binding. The example is disabled. A binding requires the platform account ID, ownership/operation authorization, the identity marker and the actual own-profile URL. Never infer a mapping from a currently open personal browser.

Use each project's existing launcher. The module is part of the long-lived bridge and checks its durable schedule every 15 seconds; no Codex chat or temporary script drives it. An abrupt bridge exit releases the OS process; a stale worker/account lock is recovered only after its recorded PID is no longer alive. A live lock is never stolen. After restarting a bridge, only today's missing daily job may be enqueued. Historical days are cancelled rather than replayed. No new Windows startup task is installed.

timeZone is an explicit IANA zone. Daily slots and Monday-to-Sunday natural weeks use it, including DST. Deployment must preserve the earlier background window's meaning. The private schedules, account identities, login verification and local startup details belong in each machine's handoff.

The local admin console reuses the restricted loopback console session. It displays schedules, costs/limits, connection gates, selected interests/memories, recent tasks, final draft copy, hashes, receipts, links and actionable reports. Its inputs do not allow editing a persona or arbitrary task code. The CLI supports status, connection, user-operated login, independent pause/resume, cancelling an unsubmitted draft and monetary budget adjustment. It cannot force model/browse/publish work.

## Reading, memory and interest evidence

A daily job has a durable ID per bot/local date and checkpoints source progress. QQ receives priority; the worker aborts its own model turn, then resumes from saved progress while the same-day window and cumulative task-time budget permit. It never holds the QQ send queue or front-end model semaphore during a browsing step. Reading does not consume the existing autonomous-wake counter.

Default limits are six items per platform/local day, 15 active task minutes, bounded model input/output, generated assets and media bytes. The initial media-reading limits are zero model images and zero video seconds: title/body/description/caption text is distinguished explicitly; no visual understanding is claimed. Consecutive unavailable/duplicate material can end a job early.

The following are separate:

- seen: IDs, fingerprints and bounded dedup/progress metadata, retained 30 days.
- notes: optional working notes and their source excerpts, retained seven days.
- memories: zero or more selected entries with a reason, source snapshots and revision history.
- interests: the bot's own reaction, question or stance, with separate evidence/revision history.

Sources carry platform, content ID, original/canonical link, author, fetch time, actual read range and interest topic. Author self-reports, external claims, verified information and self-judgments are different categories. The web adapter does not certify posts as verified facts. Video descriptions do not prove understanding of images or the whole video. Public reading is not offline experience.

Memory and interest revisions require the previous record and a change reason. Withdrawal preserves history and removes support. Stable interest display requires at least three independent origin fingerprints, two authors and observations spanning at least 24 hours. Re-reading, text-identical/near-identical reposts and content from the shared account do not create new independent support. Text similarity cannot prove every semantic repost relationship; uncertain evidence remains tentative. No social row is injected as a new QQ observation.

Only a relevant public-memory summary is made available to an existing QQ scene. Private people, conversations and agreements remain in their original scenes. A planning prompt may receive abstract own-interest topics and unfinished-question topics; drafts are generated exclusively from actual public source records. No private transcript becomes a publication source. Public interests do not authorize unsolicited group messages.

The active seen/notes retention does not delete existing QQ/model session archives, personality, diaries, chat logs or costs. Task source excerpts expire after the note period unless preserved as selected memory or immutable publication provenance. Runtime recovery copies have a short independent retention; code/config backups remain private.

## Model budgets and boundaries

Metered models reserve a conservative per-call amount before submission, then settle actual reported usage. Unknown outcomes keep the reservation charged. Requests stop at per-day/per-week/social/shared-background limits or an overrun. The existing fish background cost calculation includes social spend, preventing independent wake and social budgets from ignoring one another. Monetary ceilings are admission thresholds, not a provider billing guarantee for an already submitted request.

For an explicitly authorized Antigravity subscription deployment, social requests pass a session-only useG1Credits:false override, use fresh nonpersistent conversations and separate daily request counters. They do not estimate subscription cost with DeepSeek rates. The installed CLI exposes no verified provider-side output-token cap. Request count, timeout, bounded input, stream volume and returned-text limits apply; provider-internal reasoning tokens cannot be guaranteed by an application character limit. Keep this limitation visible.

DS social sessions have tools removed at SDK setup and denied in the permission hook. Antigravity social sessions pass an empty QQ context and session-only denies for commands, files, URLs, MCP and agents. They cancel on any observed tool step. External text and model JSON cannot choose browser actions, local paths or arbitrary tools.

## Drafts, shared-account publication and recovery

Each platform/account has one shared profile, process lock and publication ledger. A shared account must have one agreed weekly timeZone. Authors alternate by natural week; a fixed later fallback slot allows the other bot to fill an unfinished quota. Each receipt records the actual creator. A successful shared receipt fulfills the account/platform/week once, not once per bot.

Before publishing, immutable final text, original diagram PNGs, rights metadata, content/material hashes and task ID are saved on D:. Asset code escapes all model text and makes no third-party image requests. Content validation rejects private-material markers, fabricated offline first-person experience, excessive verbatim overlap and similar prior posts. Drafts include source attribution and AI disclosure. The current editor must provide uniquely identifiable controls; an ambiguous editor or declaration pauses publication.

States: pending, running, draft_complete, pending_publish, confirming, succeeded, failed, cancelled. An intent is saved to the shared ledger before the sole final publish click. Crash recovery or an unclear response goes to confirmation, never straight to resubmission. The account cannot publish another post while any shared intent remains unresolved.

Confirmation requires the signed-in bound account, its selected published list, a unique matching title and real post ID/time evidence. Where available, the official creator UI's own JSON responses provide a bounded title/ID/timestamp record; no hidden or undocumented API request is generated. Otherwise the displayed timestamp is stored verbatim with its uncertainty. An exact timestamp determines the natural week; a submission/confirmation interval wholly inside one week can safely bound the week. Cross-week ambiguity does not fulfill a quota. A generic success toast alone is insufficient.

Network errors have bounded backoff. Login, challenge, account mismatch and capability changes persist a platform gate until a user-operated login and connection inspection succeeds. A fixed same-week retry opportunity is distinct from unbounded retries. Unresolved submissions retain their immutable material for an administrator's later confirmation. Cancelling a draft never deletes an existing platform post.

Actionable failures appear locally and may produce a bounded notice to the already configured private owner during natural scheduling, through the existing QQ queue. Notice intent is persisted before sending; an unclear QQ receipt is not resent. No group permission is added.

## Allowed validation and handoff limits

Use necessary node --check, inline-script parsing, JSON/YAML/PowerShell syntax parsing, Git whitespace/secret-path review, process identity/idle checks and login/connection inspection only. Do not run regression suites, *.test.mjs, historical self-check scripts, extra model tests, QQ test messages or test posts.

Loaded code, a ready runtime and an upload entrance are not proof of a successful read, chosen memory, post or personality change. Check those only from authorized natural schedules and durable evidence.

Primary references: [Xiaohongshu creator platform](https://creator.xiaohongshu.com/), [Antigravity CLI flags and settings](https://antigravity.google/docs/cli/reference/), [Antigravity settings schema](https://antigravity.google/schemas/v1/settings.json). Account-specific capabilities must still be verified in the current signed-in interface.
