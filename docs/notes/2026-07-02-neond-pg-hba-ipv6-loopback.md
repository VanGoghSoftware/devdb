# neond pg_hba template: `::1/32` is not IPv6 loopback

**Date:** 2026-07-02
**Found during:** code review of the phase-1 ported compute pg_hba template
**Status:** fixed in DevDB's port; not reported upstream (project policy: no upstream reports)

## The bug

`src/mgmt/compute/pg_hba.conf` line 4 in neond (local clone `~/git/neond`):

```
host    all       cloud_admin   ::1/32        trust
```

The intent — paired with the `127.0.0.1/32` line above it — is clearly "trust cloud_admin from IPv6 loopback". But `::1/32` is a 32-bit **prefix**, not a host address: it matches every IPv6 address whose first 32 bits are zero. That covers far more than loopback, notably the entire IPv4-mapped block `::ffff:a.b.c.d` — i.e. every IPv4 peer as it appears on a dual-stack IPv6 socket.

The IPv6 loopback host route is `::1/128`.

## Security implication

`cloud_admin` is the privileged management role and the method is `trust` (no password). If a compute ever accepts a connection whose peer address is IPv6-family and falls inside `::/32`, that peer gets passwordless cloud_admin.

Concrete path: PostgreSQL's HBA matcher (`check_ip` in `src/backend/libpq/hba.c`) compares an IPv6-format entry directly against an IPv6-family peer address under the CIDR mask. A remote IPv4 client reaching the server through a dual-stack (non-`IPV6_V6ONLY`) IPv6 socket shows up as `::ffff:a.b.c.d` — IPv6 family, first 32 bits zero — and matches `::1/32` → trust.

Why it is not currently exploitable, in either codebase:

- neond computes set `listen_addresses=0.0.0.0` (`src/mgmt/compute/mod.rs:761`), an IPv4-only wildcard. With no IPv6 listening socket there are no IPv6-family peers, so today the `::1/32` line matches nothing at all (an IPv4-family peer never matches an IPv6-format entry). It is dead config — which is also why the bug is invisible in normal use.
- PostgreSQL sets `IPV6_V6ONLY` on the IPv6 sockets it binds where the platform supports it, so even with `listen_addresses='*'` v4-mapped peer addresses are unusual on modern systems.

The line goes live the moment the listener config drifts to include an IPv6 socket — `listen_addresses='*'` on a platform where v4-mapped peers occur, or a future proxy/sidecar forwarding over IPv6. A trust rule should say what it means; least privilege says `/128` regardless of today's reachability.

## Fix

One character class: `::1/32` → `::1/128`.

## DevDB status

- The ported template in the [phase-1 plan](../superpowers/plans/2026-07-02-devdb-phase-1-engine-and-branching.md) (`PG_HBA` constant in `packages/daemon/src/compute/pgconf.ts`, Task 10) carried the bug verbatim. Now fixed to `::1/128`, with a deviation comment at the definition and a pinning assertion in the Task 10 tests.
- When implementing Task 10, do **not** "fix back" to match the upstream oracle — the `/128` is a deliberate deviation.
- Upstream (matisiekpl/neond) has not been notified, per project policy of no upstream reports. If the template is ever re-synced from upstream, re-check this line.
