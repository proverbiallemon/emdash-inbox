# Contributing to emdash-inbox

Thanks for your interest. emdash-inbox is pre-alpha — the codebase is being built out against EmDash v0.5.0, which is itself evolving quickly. Expect breaking changes between commits.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/emdash-inbox.git`
3. Install dependencies (once we have any): `pnpm install`
4. See the README for the current roadmap and what's buildable

## Making Changes

1. Create a branch from `main`: `git checkout -b my-feature`
2. Make your changes
3. Run `pnpm test` and `pnpm tsc --noEmit` (once these scripts exist)
4. Commit with a clear message and push your branch
5. Open a pull request against `main`

## Pull Request Guidelines

- Describe what your PR does and why
- Keep PRs focused — one feature or fix per PR
- Include any relevant migration notes for plugin storage schema changes
- If your change involves a new EmDash plugin capability, cite the relevant section of the EmDash docs

## Code Style

- TypeScript strict mode
- Follow existing patterns in the codebase
- Match EmDash plugin conventions (descriptor + runtime split, capability-gated `ctx`)

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- EmDash version and relevant environment (Wrangler, Node, etc.)
