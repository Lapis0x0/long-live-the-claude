# Long Live the Claude

> An unofficial community plugin for Claude Code, not affiliated with or endorsed by Anthropic.

English | [简体中文](README.zh-CN.md)

*Long live the king, and long live the Claude.* This plugin keeps a long-running Claude Code session alive: it shows your usage at a glance, keeps the prompt cache warm through idle gaps, and when the 5-hour limit is nearly spent it lets the model wrap up, pauses the session, and wakes it again when the window resets.

![The usage band above the prompt](assets/band.png)

## Why

Today's flagship models can work on their own for hours without a `/loop`: one long turn, background jobs, notifications that wake the model when a job finishes. Two things get in the way of a session that runs all day.

1. **The 5-hour usage window.** Past 100%, Claude Code keeps telling the model to stop, and whatever work continues is charged against your weekly allowance. Nothing brings the session back once the window resets.
2. **The prompt cache expires.** On a subscription the cache lives for one hour. After a longer gap, the first request rebuilds the cache for the whole context, which costs twice the base input price.

## What it does

**A usage band above the prompt**

- `5h` and `7d`: how much of each window is left. The translucent part of the bar is what the current rate will use up before the reset.
- `ctx`: the context in use against the auto-compaction window, the same basis as `/context`.
- `cache`: a ring and countdown until the prompt cache expires.
- Click the band for details, each right below its reading: when each window resets and whether it will run out early at the current rate, the headroom to auto-compaction, and the keep-alive status.

**Long-run mode** (per conversation, off by default; the `Long run` button or `/long-run`)

- **Keep-alive through idle gaps.** About 3 minutes before the cache would expire, the plugin refreshes it. This covers every idle gap: you stepping away, the model waiting on a background job, or a usage pause.
- **Check-ins, so a stalled wait does not stall the session.** A model often ends its turn to wait on a background job, and if that job hangs or its notification never comes, nothing wakes the model again. So while the model has not said it is done, the refresh is a short turn in the conversation itself: a one-line `[long run] check-in`, plus a system reminder only the model sees, asking it to check on what it was waiting for and carry on, or simply end the turn if all is well. When the model judges it should genuinely stop (the task is done, or it is waiting for you), it ends its reply with `[idle]` on a line of its own; from then on the refresh is a silent forked request until the next new message. Interrupting a turn counts as `[idle]` too. A check-in reads the same cached context as a forked keep-alive, so it costs about the same.
- **A graceful pause at 95% of the 5-hour window.** The next tool result the model gets carries a system reminder: the limit is nearly reached and resets at a given time, so it should bring the current step to a natural stop and end the turn. The model is not asked to write notes or checkpoints: for the model, the pause is just a gap between one message and the next.
- **Notifications are held, not lost.** While paused, background task notifications and scheduled triggers do not start new turns. Their text is kept and handed to the model at wake-up. Anything you type yourself still goes through.
- **Automatic wake-up.** Two minutes after the reset the plugin submits a prompt telling the model how long it was paused, together with the held notifications. Because the cache was kept warm, that first request is cheap.
- **Survives restarts.** The switch and any pause in progress are stored per conversation, so they come back after an app restart or a resumed session.

## The cost math

On a subscription with the 1-hour cache:

| | Cost, in units of "the whole context at base input price" |
| --- | --- |
| One keep-alive (a cache hit) | 1/20 = 0.05 |
| Rebuilding the cache after it expired | 2 |

One keep-alive per ~57 minutes means about **40 keep-alives (~38 hours) cost as much as one rebuild**. So long-run mode keeps the cache warm until the conversation has been idle for 36 hours, and every real request restarts that clock. A typical usage pause of up to 5 hours costs about 5 keep-alives, 0.25 of a context, against 2 for a rebuild.

This is also why the pause happens at 95% rather than 100%: the session stops before it starts drawing on extra usage.

## Install

Requirements:

- Claude Code **2.1.286** or later (plugins with function hooks).
- A Claude subscription (Pro or Max) for the `5h` / `7d` readings and the usage pause. With an API key, the band shows the context and cache only, and keep-alive still works.

The easiest way is to ask Claude Code itself:

```
Hey Claude, install this mod for me: https://github.com/Lapis0x0/long-live-the-claude
```

Or from the plugin marketplace:

```
/plugin marketplace add Lapis0x0/long-live-the-claude
/plugin install long-live-the-claude@long-live-the-claude
```

Or from a local clone:

```bash
claude --plugin-dir /path/to/long-live-the-claude
```

## Usage

- **`Long run`**: turns long-run mode on for this conversation; it reads `Long run ✓` while on.
- **`Refresh`**: sends one keep-alive now.

| Command | What it does |
| --- | --- |
| `/long-run` or `/long-run on` | Turn long-run mode on |
| `/long-run off` | Turn it off; a pause in progress ends and held notifications go to the model right away |
| `/long-run test` | Send one keep-alive and report the cache hit |
| `/long-run nudge` | Send one check-in now |
| `/long-run sim <minutes>` | Simulate crossing 95% with the window resetting in `<minutes>`, to watch a pause and wake-up end to end |
| `/long-run debug <minutes>` | Refresh every `<minutes>` instead of hourly, for testing |

## Settings

The thresholds are constants at the top of [`hooks/register.tsx`](hooks/register.tsx):

| Constant | Default | Meaning |
| --- | --- | --- |
| `PAUSE_AT` | `95` | Percentage of the 5-hour window at which the wind-down starts |
| `WAKE_DELAY_MS` | 2 minutes | How long after the reset to wake the session |
| `IDLE_CAP_MS` | 36 hours | How long the conversation may sit idle before keep-alive and check-ins stop |
| `TTL_MS` | 1 hour | The assumed cache lifetime; a keep-alive that misses stops automatic keep-alive |

## Development

```bash
git clone https://github.com/Lapis0x0/long-live-the-claude
cd long-live-the-claude
claude --plugin-dir .
```

Inside that session, run `/plugin-types` to write the plugin API declarations to `.claude/types`; then `tsc -p tsconfig.json` type-checks the plugin and `claude plugin validate .claude-plugin/plugin.json` checks it the way Claude Code loads it.

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do) community.

## License

[MIT](LICENSE)
