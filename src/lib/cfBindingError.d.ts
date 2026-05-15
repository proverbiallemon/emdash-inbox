/**
 * Ambient declaration for the Cloudflare Workers virtual module.
 *
 * Our deliverEmail() does `await import("cloudflare:workers")` to reach
 * `env.EMAIL`. That module is provided by workerd at runtime but has no
 * type declarations in the worktree's tsconfig. We declare a minimal shape
 * here — narrow enough to typecheck our use, broad enough that the actual
 * runtime env (which contains all of the host's bindings) still satisfies
 * it.
 *
 * Lives next to cfBindingError.ts (rather than a project-root types.d.ts)
 * so binding-related types live with binding-using code.
 */
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;
}
