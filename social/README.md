# Public reading and original publishing

Both QQ bridges load this module only when a private social.config.json exists beside bridge.mjs. Run the existing project launchers. The schedule is stored in JSON and task state, independent of a Codex chat. No model, browser-reading or posting command is exposed by the management CLI.

Current platform adapter: Xiaohongshu creator and consumer web interfaces. Douyin is deliberately not connected. No undocumented publishing API is called.

Local management:

- DeepSeek: http://127.0.0.1:3102/social
- Gemini: http://127.0.0.1:3103/social
- CLI: use the project's D-drive Node executable with social/cli.mjs status --bot deepseek (or gemini).
- connection checks the signed-in account and empty upload entrance only.
- login --surface browse or login --surface creator opens the isolated browser for the user. It never fills an authentication form.
- pause-browse / resume-browse and pause-publish / resume-publish are independent.
- cancel-draft --task TASK_ID cancels only a draft that has not been submitted.
- budget --daily 0.15 --weekly 0.8 --shared-daily 0.2 changes monetary limits. Included subscription request limits remain separate.
- There is no force-run, test-post, delete-post, like, follow, comment, direct-message, live-stream, shopping or general desktop command.

The project config and all state are private. Do not commit social.config.json, social-data, .social-shared, .social-backups, browser profiles, drafts or receipts. See ../docs/social.md for design and maintenance limits.
