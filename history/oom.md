# Archive server OOM incident notes

Session date: 2026-07-24. Times below are UTC unless stated otherwise.

## Executive summary

The client error

```text
lax submit: cannot reach the archive server at http://167.233.125.220:8080/ (fetch failed)
```

was a symptom of the archive service being killed by the Linux OOM killer. It
was not a Git, GitHub authentication, DNS, or client configuration problem.

All three observed failures were Lax8 builds of the same source triple:

```text
repository: https://github.com/EdouardBonnet/chi-boundedness-lnc-merge-width
commit:     9c6feb47e7db3076930b68cef2b104ec6eea67a8
folder:     .
```

The expensive phase is `leanchecker`. It finds every matching olean and starts
an `IO.asTask` for every matching module. Its runtime task pool defaults to the
machine's CPU count, so adding CPUs increased parallelism and memory pressure.

This was resolved by explicitly forwarding `LEAN_NUM_THREADS` into the
Replay/Inspect bubblewrap profile. The exact workload was renamed to Lax9 and
completed successfully with four workers: the service peaked at 14.7 GiB RAM
and 17.3 GiB swap instead of exhausting all 31.9 GiB of swap.

After that validation, server Replay was disabled for general submissions. A
second Lax9 run skipped `leanchecker`, completed in about 75 seconds, and
returned an explicit weakened-verification warning. The final switch is
disabled-by-default: only `LAX_SERVER_REPLAY=1` enables Replay.

## Incident timeline

| Time | Event |
|---|---|
| 13:51:08 | Lax8 job `aef2db3b6e61712fccd576e192b0c0a4` accepted on the original CPX32. |
| 14:20:27 | First OOM kill after about **29m 19s**. `leanchecker` had about 7.2 GiB resident and 15.9 GiB swapped. |
| 14:20:33 | systemd restarted `lax-server`; it listened again at 14:20:34. |
| 14:29:14 | Swapfile expanded from 16 GiB to 32 GiB and the service restarted successfully. |
| 14:30-14:33 | Server rescaled in place from CPX32 to CPX42, retaining the existing 160 GB disk and IP. |
| 14:34:41 | Lax8 job `1846291446c8bd828268753c5cdf7445` accepted on CPX42. |
| 14:40:06 | Second OOM kill after about **5m 24s**. The unit peaked at 14.8 GiB RAM and 31.9 GiB swap. |
| 14:40:11 | systemd restarted the archive. |
| 14:49 | Added a persistent systemd drop-in with `LEAN_NUM_THREADS=4`; attempted CX53 rescale twice. Both attempts returned Hetzner `resource_unavailable`. The unchanged CPX42 was booted again. |
| 14:51:22 | Lax8 job `f8bdc1fcb1e07b7253aeb9fac8cb0694` accepted after the systemd drop-in was installed. |
| 14:56:47 | Third OOM kill after about **5m 24s**, again peaking at 14.8 GiB RAM and 31.9 GiB swap. This proved the systemd variable was not entering the sandbox. |
| 14:56:52 | systemd restarted the archive again. |
| 15:09 | Deployed `lax-archive@0.1.2` with `LEAN_NUM_THREADS` forwarded into the check sandbox; an installed bubblewrap probe printed `LEAN_NUM_THREADS=4`. |
| 15:13:55 | Lax9 job `a3120d8b7e2ca60e67ffb01bcfa8d048` accepted. It used the exact Lax8 source revision, mechanically renamed to the newly allocated Lax9 ID. |
| 15:20:15 | Lax9 succeeded as a draft after about **6m 20s**. The unit later reported peaks of 14.7 GiB RAM and 17.3 GiB swap, with no OOM event. |
| 15:23 | Deployed the emergency `LAX_SERVER_REPLAY=0` switch and activated it through a runtime systemd drop-in. |
| 15:23:33 | Lax9 resubmission `3bc5dfe9be0be39881cd3272762a52ec` accepted for end-to-end bypass verification. |
| 15:24:48 | Replay-disabled Lax9 succeeded after about **75s**, launched `laxinspector` without `leanchecker`, and returned the expected warning. |
| 15:37:54 | Deployed the final disabled-by-default switch, removed the runtime override, and restarted healthy. With `LAX_SERVER_REPLAY` unset, installed code reported `default=false`; an explicit value of `1` reported `opt_in=true`. |

An OOM restart destroys the in-memory job record. The client may see a
transport failure during the brief outage or a 404 after reconnecting. The job
must be resubmitted; no archive database write occurs unless the job completes.

## What was investigated

- Direct HTTP checks to `/` and `/healthz` returned HTTP 200 whenever the
  service was running.
- Node `fetch` also succeeded outside the local Codex network sandbox. A local
  `connect EPERM` seen during diagnosis was caused by that sandbox and was not
  the production failure.
- `systemctl`, service journal, and kernel journal confirmed each OOM kill.
- Kernel task dumps identified `leanchecker`, not the Node server, as the
  memory consumer selected by the OOM killer.
- The authoritative database mirror and public site remained intact.
- No submit pipeline was active before either planned server resize.
- The current repository implementation was inspected for job concurrency,
  sandbox environment handling, Replay, and job persistence.

One diagnostic mistake is worth recording: `leanchecker --help` is not a help
command. The checker interpreted the absent target as “check the current
project”, began allocating memory, and was immediately terminated after it was
noticed. It did not belong to a submit and caused no service or data change.

## Root cause details

The Lean 4.30 source at
`$TOOLCHAIN/src/lean/LeanChecker.lean` does the following:

1. partitions dash-prefixed arguments as flags;
2. recognizes only `-v`/`--verbose` and `--fresh`;
3. finds every olean below the requested module prefix;
4. creates an `IO.asTask` for every module before waiting for results.

Consequences:

- Built-in `leanchecker --num-workers=4` is **not supported** by this version.
  The unknown flag is silently discarded.
- `--fresh` is a different single-module verification mode and is not a
  drop-in replacement for the archive's prefix replay.
- The Lean runtime does support `LEAN_NUM_THREADS`. In Lean v4.30.0,
  `src/runtime/object.cpp:get_lean_num_threads()` reads that environment
  variable before constructing the task manager.

The attempted systemd configuration is:

```ini
# /etc/systemd/system/lax-server.service.d/lean-threads.conf
[Service]
Environment=LEAN_NUM_THREADS=4
```

It was present and visible in `systemctl show lax-server -p Environment`, but
was initially ineffective for Replay because `src/server/sandbox.ts` starts
bubblewrap with `--clearenv`. Before the fix, the check sandbox forwarded only:

```text
LEAN_PATH
PATH
HOME
```

The deployed check profile now forwards `LEAN_NUM_THREADS` explicitly. Reading
the live `leanchecker` process environment during Lax9 confirmed the value was
`4`.

## Infrastructure changes made

### Swap

`/swapfile` was expanded from 16 GiB to 32 GiB:

```text
/swapfile none swap sw 0 0
```

The existing `/etc/fstab` entry was retained, so the new size survives reboots.
The resize briefly stopped the archive service. No build was running.

### Server plan

The live server was rescaled in place:

```text
CPX32: 4 shared vCPU,  8 GB RAM
CPX42: 8 shared vCPU, 16 GB RAM
```

`--keep-disk` was used. Hetzner describes CPX42 as having a 320 GB plan disk,
but the guest disk intentionally remains the original 160 GB (about 150 GiB
formatted). This preserves downgrade paths to plans with a 160 GB disk.

The following did not change:

- server ID `154491090`;
- public IPv4 `167.233.125.220`;
- filesystem contents and SSH keys;
- `/home/lax/.lax-server` database, warm store, site, and configuration;
- systemd service and database mirror.

Two attempts to change CPX42 to CX53 with `--keep-disk` failed with
`resource_unavailable`. Hetzner made no plan change and the server was restored
as CPX42.

### Pricing observed from the live Hetzner API

These were the project/account prices shown during the session:

| Plan | vCPU | RAM | Hourly | Monthly cap |
|---|---:|---:|---:|---:|
| CPX32 | 4 | 8 GB | EUR 0.06828 | EUR 42.588 |
| CPX42 | 8 | 16 GB | EUR 0.13368 | EUR 83.388 |
| CX43 | 8 | 16 GB | EUR 0.03072 | EUR 19.188 |
| CX53 | 16 | 32 GB | EUR 0.05676 | EUR 35.388 |

Hetzner bills a server hourly while it **exists**, whether powered on or off,
up to its monthly cap. Deleting the server, not powering it off, stops compute
billing. Prices and capacity should be rechecked before future changes.

CX plans use older, cost-optimized shared x86 hardware. CPX plans use newer
regular-performance shared hardware. CX53 is still attractive for this
memory-heavy batch workload, but its 16 CPUs make a working task-pool cap
mandatory; otherwise it could increase `leanchecker` parallelism again.

## Current live state after resolution

```text
Plan:              CPX42
CPU:               8 shared vCPU
RAM:               16 GB (15 GiB reported by Linux)
Swap:              32 GiB
Guest filesystem:  150 GiB, about 100 GiB available
IPv4:              167.233.125.220
Service:           lax-server.service, Restart=on-failure
Package:           lax-archive@0.1.2
Lean workers:      LEAN_NUM_THREADS=4 (persistent systemd drop-in)
Server Replay:     disabled by default (LAX_SERVER_REPLAY=1 enables it)
Database mirror:   https://github.com/jan3er/lax-db.git
```

The service is healthy and the thread limit is effective inside bubblewrap.
Replay remains disabled when `LAX_SERVER_REPLAY` is unset, including after a
reboot. Submissions built while it is disabled receive a warning that their
compiled oleans were inspected without independent kernel replay.

Killed jobs left scratch directories because the Node process could not run
its `finally` cleanup after the unit was killed. At session end the jobs
directory contained at least:

```text
1846291446c8bd828268753c5cdf7445
aef2db3b6e61712fccd576e192b0c0a4
f310ed7e5dabe8f3a8f5546881090798
f8bdc1fcb1e07b7253aeb9fac8cb0694
```

These are not active jobs. They can be removed later after a final read-only
check, but no cleanup was performed in this session.

## Resolution and verification

The Replay/Inspect sandbox profile now includes:

```ts
env: {
  LEAN_NUM_THREADS: process.env.LEAN_NUM_THREADS ?? "4",
  LEAN_PATH: leanPath.join(path.delimiter),
  PATH: `${toolchainBinDir()}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: jobHome,
},
```

Verification completed:

1. tests cover the default worker limit, an explicit override, and the Replay
   feature switch;
2. the relevant bubblewrap-backed server tests and TypeScript build passed;
3. the clean npm package was installed and the service restarted healthy;
4. a direct installed-code bubblewrap probe preserved `LEAN_NUM_THREADS=4`
   across `--clearenv`;
5. `/proc/<leanchecker>/environ` during the live run also contained
   `LEAN_NUM_THREADS=4`;
6. the exact workload succeeded as Lax9 with Replay enabled;
7. a second live run verified the temporary Replay bypass and warning.

Four workers fit, but the successful job still used most physical RAM and more
than half the swap. Before re-enabling Replay for general submissions, decide
whether to retain four workers, lower the limit to two for more headroom, or
serialize submits. Longer-term infrastructure choices remain:

- staying on CPX42 temporarily;
- rescaling to cheaper CX43 with the same nominal RAM/CPU;
- retrying CX53 when Falkenstein capacity becomes available.

## Longer-term improvements

1. **Serialize submit pipelines.** The server currently starts each accepted
   submit immediately. Concurrent heavy jobs can multiply memory use.
2. **Persist job records.** `JobStore` is in memory, so every service restart
   loses job handles and produces 404 responses during polling.
3. **Apply explicit resource limits.** Bound worker count and possibly memory,
   PIDs, and scratch disk per build. Treat an exceeded limit as a failed job,
   not a server-wide outage.
4. **Improve transport diagnostics.** Preserve nested Node `fetch` causes such
   as `ECONNREFUSED`, timeout, or permission errors instead of reporting only
   `fetch failed`.
5. **Consider an ephemeral worker architecture.** A small always-on API/site
   server could create a pre-warmed CX53 worker per queued build, collect its
   trusted output, and delete it. This needs durable jobs and a clean split
   between control-plane state and build-worker artifacts.

## Useful operational commands

```sh
# Health
curl -fsS http://167.233.125.220:8080/healthz

# Service and build logs
ssh root@167.233.125.220 'systemctl --no-pager --full status lax-server'
ssh root@167.233.125.220 'journalctl -u lax-server -f'

# OOM evidence
ssh root@167.233.125.220 'journalctl -k --since today | grep -i -E "oom|out of memory|leanchecker"'

# Current capacity
ssh root@167.233.125.220 'free -h; swapon --show; df -h /'

# Effective service environment (not the same as sandbox environment)
ssh root@167.233.125.220 'systemctl show lax-server -p Environment'

# Current Hetzner plan
hcloud server describe lax-server

# Retry CX53 availability after the code fix is deployed
hcloud server shutdown lax-server
hcloud server change-type --keep-disk lax-server cx53
hcloud server poweron lax-server
```

Do not leave the server powered off after a failed rescale attempt: powered-off
servers are still billed and the archive remains unavailable.

## Repository/worktree note

The final repository commit combines the interrupted-submit resume work, the
Replay worker-limit fix, the temporary server Replay switch, tests,
documentation, and these incident notes.

## Resolution (2026-07-26)

The `LAX_SERVER_REPLAY` switch is gone; server Replay is unconditional again.

The switch was the right emergency move on 2026-07-24 and the wrong permanent
state. Its stated condition for removal — "enable it explicitly after
provisioning headroom" — was met by the front/worker split later the same
week: builds no longer share a machine with the archive service, and the
worker is a dedicated cpx42 whose only tenant is the job. The actual root
cause was already fixed at the time, by forwarding `LEAN_NUM_THREADS` (default
4) into the Replay/Inspect sandbox profile so leanchecker stops sizing its task
pool from the machine's CPU count.

The switch was found by accident, and how it was found is the part worth
keeping. Nothing was monitoring it. It surfaced in the output of an unrelated
failure-path test, in a warning line above the violations nobody was reading.
The split had also silently disconnected it: Replay runs in the untrusted
half, which is now the worker, while the operator-facing variable was set —
or in this case not set — on the front. Setting it there would have changed
nothing while looking like it had.

Records built in the 2026-07-24 to 2026-07-26 window keep their
weakened-verification warning. It is a true statement about those builds, and
the pipeline can no longer emit it.
