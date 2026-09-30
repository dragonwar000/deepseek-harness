/** Node half: the AI Account settings plugin renders only in the browser. */

/** Services the browser half requires; the Node half uses none of them. */
export const inject = ['slots', 'locale']
/** Register nothing on the Host; the Loader row exists so the client module system serves the browser half. */
export function apply(): void {}
