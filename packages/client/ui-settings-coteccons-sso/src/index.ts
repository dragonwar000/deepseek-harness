/**
 * Node half: the Coteccons SSO settings group renders only in the browser. The
 * row exists so `client-modules` serves the browser half from the package's
 * `dsh.client` declaration; `slots` and `locale` are browser services and are
 * declared by `./client`, never here — a Host row injecting them never
 * activates.
 */

/** Register nothing on the Host; this surface plugin owns no host-side behavior. */
export function apply(): void {}
