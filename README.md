# Introduction

A self-hosted, lightweight work tracker for a single team — think of it as a
minimal Linear clone. It gives a small team one place to plan projects, track
issues on a live board, and manage who's on the team, without the operational
weight of a large SaaS platform.

The product is built around one guiding principle: **minimize build and
maintenance cost**. Every capability is intentionally scoped small so the whole
system runs on a single server with the smallest viable footprint.

## What it does

### Project management

Organize work into projects. Each project holds its own specs, milestones, and a
roadmap so the team can capture what's being built and track progress toward it.

### Issue & task management

A Trello-style board with columns and draggable cards. Issues carry titles,
descriptions, assignees, priorities, labels, and comments. Card moves are
**live** — teammates viewing the same board see updates within about a second.

### Member management

Invite teammates by email, assign roles (admin or member), and manage access.
Admins handle invitations, role changes, and suspending or removing members;
everyone else works within the project and board they belong to.

## What it deliberately is not

These limits are choices, not gaps. They keep the system small, cheap, and easy
to operate.

1. **Single workspace, single team.** One workspace and one team, seeded at
   setup. No multi-tenancy, no team switching.
2. **Small workloads.** Designed for a small team (fewer than ~20 people) and the
   modest amount of data that produces. It is not tuned for large-scale usage.
3. **Single point of failure.** Runs as one instance with no high-availability
   or redundancy. A restart or deploy causes a few seconds of downtime, after
   which clients reconnect automatically.
4. **Scaling is out of scope.** No horizontal scaling, no Redis, no load
   balancing. Growing beyond a single team's needs is explicitly a non-goal.

## Who it's for

A single small team that wants Linear-style project and issue tracking they can
run and own themselves, and who value simplicity and low running cost over
scale, redundancy, and multi-tenant flexibility.

---

For the full technical specification — architecture, data model, security, and
operations — see [the PRD](./docs/prd/linear-clone.md).
